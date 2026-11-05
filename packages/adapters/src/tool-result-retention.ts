/**
 * Deletes offloaded tool-result files that nothing has touched for a long time.
 *
 * Oversized tool results are written to `<home>/work/<agent>/<conversation>/tool-results/` so
 * the model can page them back with `retrieve_tool_result`. The only other deletion is
 * deleting the conversation itself, so a conversation that is simply abandoned keeps its files
 * forever. This sweep removes files there whose modification time is older than the retention
 * window.
 *
 * Only `tool-results/` is swept. `journal.jsonl` and `state.json` beside it are what a resumed
 * conversation rebuilds its context from, and `workspace/` and `generated/` hold material the
 * user or an artifact refers to; none of those age out.
 *
 * A conversation is left alone when it holds the turn lease, when it is open in this process,
 * or when its log was written within the retention window. A resumed conversation whose result
 * file is gone is not an error: `retrieve_tool_result` answers that nothing is stored and tells
 * the model to rerun the original tool.
 *
 * `scheduleToolResultSweep` runs the sweep once per process, off the critical path, and at most
 * once per `TOOL_RESULT_SWEEP_INTERVAL_MS` per Jazz home across processes (a stamp file's
 * modification time records the last run). A retention of 0 disables it.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import {
  conversationLogPathForSegments,
  conversationTurnLockPathForSegments,
} from "./history/conversation-log";
import {
  nodeSweepFileSystem,
  sweepStaleFiles,
  type SweepFileSystem,
  type SweepResult,
} from "./stale-file-sweep";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days an offloaded result is kept when `history.toolResultRetentionDays` is unset: long enough
 * that any conversation resumed within a month still finds its results, short enough that
 * abandoned ones do not accumulate for a year.
 */
export const DEFAULT_TOOL_RESULT_RETENTION_DAYS = 30;

/** Most entries one sweep examines; a backlog beyond this is finished by the next sweep. */
export const MAX_SWEEP_ENTRIES = 20_000;

/** Minimum time between sweeps of one Jazz home, across processes. */
export const TOOL_RESULT_SWEEP_INTERVAL_MS = MILLISECONDS_PER_DAY;

/** How long after startup the sweep waits, so it never competes with the first prompt. */
export const TOOL_RESULT_SWEEP_STARTUP_DELAY_MS = 15_000;

const WORK_DIRECTORY_NAME = "work";
const TOOL_RESULTS_DIRECTORY_NAME = "tool-results";
const SWEEP_STAMP_FILENAME = ".tool-results-swept-at";

export interface ToolResultSweepLogger {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

const silentLogger: ToolResultSweepLogger = { debug: () => undefined, warn: () => undefined };

export interface ToolResultRetentionOptions {
  readonly jazzHome: string;
  readonly now: number;
  /** 0 disables the sweep. */
  readonly retentionDays: number;
  readonly maxEntries?: number;
  /** Path segments (`<agent>/<conversation>`) of conversations open in this process. */
  readonly openConversations?: ReadonlySet<string>;
  readonly fileSystem?: SweepFileSystem;
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly logger?: ToolResultSweepLogger;
}

export interface ToolResultRetentionResult {
  readonly skipped: "disabled" | "no-work-directory" | undefined;
  readonly conversationsVisited: number;
  readonly conversationsProtected: number;
  readonly sweep: SweepResult;
}

const EMPTY_SWEEP: SweepResult = {
  examined: 0,
  deletedFiles: 0,
  deletedSymlinks: 0,
  prunedDirectories: 0,
  bytesFreed: 0,
  truncated: false,
  failures: [],
};

/** The key a conversation is identified by in `openConversations`. */
export function openConversationKey(agentSegment: string, conversationSegment: string): string {
  return `${agentSegment}/${conversationSegment}`;
}

async function listDirectories(
  fileSystem: SweepFileSystem,
  directory: string,
): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await fileSystem.readdir(directory);
  } catch {
    return [];
  }
  const directories: string[] = [];
  for (const name of names) {
    try {
      const stat = await fileSystem.lstat(path.join(directory, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.push(name);
      }
    } catch {
      continue;
    }
  }
  return directories;
}

async function exists(fileSystem: SweepFileSystem, target: string): Promise<boolean> {
  try {
    await fileSystem.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function conversationIsProtected(
  fileSystem: SweepFileSystem,
  options: ToolResultRetentionOptions,
  agentSegment: string,
  conversationSegment: string,
  maxAgeMs: number,
): Promise<boolean> {
  if (options.openConversations?.has(openConversationKey(agentSegment, conversationSegment))) {
    return true;
  }
  const historyDirectory = path.join(options.jazzHome, "history");
  if (
    await exists(
      fileSystem,
      conversationTurnLockPathForSegments(agentSegment, conversationSegment, historyDirectory),
    )
  ) {
    return true;
  }
  try {
    const log = await fileSystem.lstat(
      conversationLogPathForSegments(agentSegment, conversationSegment, historyDirectory),
    );
    return options.now - log.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

/** Sweeps every conversation's `tool-results/` under one Jazz home. Never throws. */
export async function sweepOrphanedToolResults(
  options: ToolResultRetentionOptions,
): Promise<ToolResultRetentionResult> {
  const logger = options.logger ?? silentLogger;
  const fileSystem = options.fileSystem ?? nodeSweepFileSystem;
  if (options.retentionDays <= 0) {
    logger.debug("Tool-result sweep disabled", { retentionDays: options.retentionDays });
    return {
      skipped: "disabled",
      conversationsVisited: 0,
      conversationsProtected: 0,
      sweep: EMPTY_SWEEP,
    };
  }

  const startedAt = Date.now();
  const maxAgeMs = options.retentionDays * MILLISECONDS_PER_DAY;
  const workRoot = path.join(options.jazzHome, WORK_DIRECTORY_NAME);
  const agentSegments = await listDirectories(fileSystem, workRoot);
  if (agentSegments.length === 0) {
    logger.debug("Tool-result sweep found no work directories", { workRoot });
    return {
      skipped: "no-work-directory",
      conversationsVisited: 0,
      conversationsProtected: 0,
      sweep: EMPTY_SWEEP,
    };
  }

  const budget = options.maxEntries ?? MAX_SWEEP_ENTRIES;
  let conversationsVisited = 0;
  let conversationsProtected = 0;
  let examined = 0;
  let deletedFiles = 0;
  let deletedSymlinks = 0;
  let prunedDirectories = 0;
  let bytesFreed = 0;
  let truncated = false;
  const failures: SweepResult["failures"][number][] = [];

  for (const agentSegment of agentSegments) {
    const agentDirectory = path.join(workRoot, agentSegment);
    for (const conversationSegment of await listDirectories(fileSystem, agentDirectory)) {
      if (examined >= budget) {
        truncated = true;
        break;
      }
      conversationsVisited += 1;
      if (
        await conversationIsProtected(
          fileSystem,
          options,
          agentSegment,
          conversationSegment,
          maxAgeMs,
        )
      ) {
        conversationsProtected += 1;
        continue;
      }
      const conversationDirectory = path.join(agentDirectory, conversationSegment);
      const toolResults = path.join(conversationDirectory, TOOL_RESULTS_DIRECTORY_NAME);
      if (!(await exists(fileSystem, toolResults))) {
        continue;
      }
      const result = await sweepStaleFiles({
        root: toolResults,
        now: options.now,
        maxAgeMs,
        maxEntries: budget - examined,
        fileSystem,
        ...(options.yieldToEventLoop === undefined
          ? {}
          : { yieldToEventLoop: options.yieldToEventLoop }),
      });
      examined += result.examined;
      deletedFiles += result.deletedFiles;
      deletedSymlinks += result.deletedSymlinks;
      prunedDirectories += result.prunedDirectories;
      bytesFreed += result.bytesFreed;
      failures.push(...result.failures);
      if (result.truncated) {
        truncated = true;
      }
      if (result.deletedFiles + result.deletedSymlinks > 0) {
        try {
          if ((await fileSystem.readdir(toolResults)).length === 0) {
            await fileSystem.rmdir(toolResults);
            prunedDirectories += 1;
            await fileSystem.rmdir(conversationDirectory);
            prunedDirectories += 1;
            await fileSystem.rmdir(agentDirectory);
            prunedDirectories += 1;
          }
        } catch {
          // A non-empty parent (state.json, journal, another conversation) ends the pruning.
        }
      }
    }
  }

  const sweep: SweepResult = {
    examined,
    deletedFiles,
    deletedSymlinks,
    prunedDirectories,
    bytesFreed,
    truncated,
    failures,
  };
  logger.debug("Tool-result sweep finished", {
    conversationsVisited,
    conversationsProtected,
    examined,
    deletedFiles,
    deletedSymlinks,
    prunedDirectories,
    bytesFreed,
    truncated,
    failureCount: failures.length,
    durationMs: Date.now() - startedAt,
  });
  if (failures.length > 0) {
    logger.warn("Tool-result sweep could not remove some paths", {
      failureCount: failures.length,
      firstOperation: failures[0]?.operation,
    });
  }
  return { skipped: undefined, conversationsVisited, conversationsProtected, sweep };
}

async function stampIsFresh(stampPath: string, now: number): Promise<boolean> {
  try {
    const stat = await nodeFs.stat(stampPath);
    return now - stat.mtimeMs < TOOL_RESULT_SWEEP_INTERVAL_MS;
  } catch {
    return false;
  }
}

/**
 * Runs the sweep when this home has not been swept within `TOOL_RESULT_SWEEP_INTERVAL_MS`.
 * Returns undefined when it was not due or is disabled. Never throws.
 */
export async function sweepToolResultsIfDue(
  options: ToolResultRetentionOptions,
): Promise<ToolResultRetentionResult | undefined> {
  const logger = options.logger ?? silentLogger;
  if (options.retentionDays <= 0) {
    logger.debug("Tool-result sweep disabled", { retentionDays: options.retentionDays });
    return undefined;
  }
  try {
    const workRoot = path.join(options.jazzHome, WORK_DIRECTORY_NAME);
    const stampPath = path.join(workRoot, SWEEP_STAMP_FILENAME);
    if (await stampIsFresh(stampPath, options.now)) {
      logger.debug("Tool-result sweep not due", { stampPath });
      return undefined;
    }
    await nodeFs.mkdir(workRoot, { recursive: true, mode: 0o700 });
    await nodeFs.writeFile(stampPath, String(options.now), { mode: 0o600 });
    const stamped = new Date(options.now);
    await nodeFs.utimes(stampPath, stamped, stamped);
    return await sweepOrphanedToolResults(options);
  } catch (error) {
    logger.warn("Tool-result sweep failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export interface ScheduleToolResultSweepOptions {
  readonly jazzHomes: readonly string[];
  /** Read when the sweep fires, so a setting changed meanwhile applies. */
  readonly retentionDays: () => number;
  readonly openConversations?: () => ReadonlySet<string>;
  readonly startupDelayMs?: number;
  /** When set, the sweep is attempted again at this interval for a long-lived process. */
  readonly repeatEveryMs?: number;
  readonly logger?: ToolResultSweepLogger;
}

let scheduledInThisProcess = false;

/** Test hook: forget that a sweep was scheduled. */
export function resetToolResultSweepSchedule(): void {
  scheduledInThisProcess = false;
}

/**
 * Schedules the sweep after startup, unref'd so it never keeps the process alive, once per
 * process. Returns false when one was already scheduled.
 */
export function scheduleToolResultSweep(options: ScheduleToolResultSweepOptions): boolean {
  if (scheduledInThisProcess) {
    return false;
  }
  scheduledInThisProcess = true;
  const logger = options.logger ?? silentLogger;
  const run = async (): Promise<void> => {
    for (const jazzHome of options.jazzHomes) {
      await sweepToolResultsIfDue({
        jazzHome,
        now: Date.now(),
        retentionDays: options.retentionDays(),
        ...(options.openConversations === undefined
          ? {}
          : { openConversations: options.openConversations() }),
        logger,
      });
    }
  };
  const timer = setTimeout(() => {
    void run();
    if (options.repeatEveryMs !== undefined) {
      setInterval(() => void run(), options.repeatEveryMs).unref();
    }
  }, options.startupDelayMs ?? TOOL_RESULT_SWEEP_STARTUP_DELAY_MS);
  timer.unref();
  logger.debug("Tool-result sweep scheduled", {
    homes: options.jazzHomes.length,
    startupDelayMs: options.startupDelayMs ?? TOOL_RESULT_SWEEP_STARTUP_DELAY_MS,
  });
  return true;
}
