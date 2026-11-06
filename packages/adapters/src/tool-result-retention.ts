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
 * once per `TOOL_RESULT_SWEEP_INTERVAL_MS` per Jazz home across processes (a private stamp directory's
 * modification time records the last successful, complete run). A retention of 0 disables it.
 */

import * as path from "node:path";
import { FileSweep, missingSweepPath, type SweepResult } from "./stale-file-sweep";
import type { SweepDirectory } from "./sweep-directory";

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
  readonly openDirectory?: (root: string) => SweepDirectory;
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

/** Opens a chain under an existing handle, closing intermediate descriptors. */
function descendant(root: SweepDirectory, names: readonly string[]): SweepDirectory {
  let current: SweepDirectory | undefined;
  try {
    for (const name of names) {
      const child = (current ?? root).child(name);
      current?.close();
      current = child;
    }
    if (current === undefined) {
      throw new Error("Empty directory chain");
    }
    return current;
  } catch (error) {
    current?.close();
    throw error;
  }
}

function conversationIsProtected(
  home: SweepDirectory,
  options: ToolResultRetentionOptions,
  agent: string,
  conversation: string,
  sweep: FileSweep,
): boolean {
  if (options.openConversations?.has(openConversationKey(agent, conversation))) {
    return true;
  }
  for (const kind of ["conversation-locks", "conversations"] as const) {
    let directory;
    const target = path.join(options.jazzHome, "history", kind, agent);
    try {
      directory = descendant(home, ["history", kind, agent]);
      const stat = directory.stat(
        `${conversation}${kind === "conversation-locks" ? ".turn" : ".jsonl"}`,
      );
      if (
        kind === "conversation-locks" ||
        !stat.isFile() ||
        options.now - stat.mtimeMs <= options.retentionDays * MILLISECONDS_PER_DAY
      ) {
        return true;
      }
    } catch (error) {
      if (!missingSweepPath(error)) {
        sweep.fail(target, "lstat", error);
        return true;
      }
    } finally {
      directory?.close();
    }
  }
  return false;
}

async function runSweep(
  options: ToolResultRetentionOptions,
  onlyIfDue: boolean,
): Promise<ToolResultRetentionResult | undefined> {
  const logger = options.logger ?? silentLogger;
  const sweep = new FileSweep({
    now: options.now,
    maxAgeMs: options.retentionDays * MILLISECONDS_PER_DAY,
    maxEntries: options.maxEntries ?? MAX_SWEEP_ENTRIES,
    ...(options.yieldToEventLoop === undefined
      ? {}
      : { yieldToEventLoop: options.yieldToEventLoop }),
  });
  let conversationsVisited = 0;
  let conversationsProtected = 0;
  const result = (
    skipped: ToolResultRetentionResult["skipped"] = undefined,
  ): ToolResultRetentionResult => ({
    skipped,
    conversationsVisited,
    conversationsProtected,
    sweep: sweep.result(),
  });
  if (options.retentionDays <= 0) {
    return onlyIfDue ? undefined : result("disabled");
  }
  let home: SweepDirectory | undefined;
  let work: SweepDirectory | undefined;
  const workPath = path.join(options.jazzHome, WORK_DIRECTORY_NAME);
  try {
    const open = options.openDirectory ?? (await import("./sweep-directory")).SweepDirectory.open;
    home = open(options.jazzHome);
    work = home.child(WORK_DIRECTORY_NAME);
    if (onlyIfDue) {
      try {
        const stamp = work.stat(SWEEP_STAMP_FILENAME);
        if (
          (stamp.isFile() || stamp.isDirectory()) &&
          options.now - stamp.mtimeMs < TOOL_RESULT_SWEEP_INTERVAL_MS
        ) {
          return undefined;
        }
      } catch (error) {
        if (!missingSweepPath(error)) {
          throw error;
        }
      }
    }
    for (const agentName of work.entries()) {
      if (!(await sweep.take())) {
        break;
      }
      let agent: SweepDirectory | undefined;
      const agentPath = path.join(workPath, agentName);
      try {
        if (!work.stat(agentName).isDirectory()) {
          continue;
        }
        agent = work.child(agentName);
        let removedConversation = false;
        for (const conversationName of agent.entries()) {
          if (!(await sweep.take())) {
            break;
          }
          let conversation: SweepDirectory | undefined;
          let results: SweepDirectory | undefined;
          const conversationPath = path.join(agentPath, conversationName);
          try {
            if (!agent.stat(conversationName).isDirectory()) {
              continue;
            }
            conversation = agent.child(conversationName);
            conversationsVisited += 1;
            if (conversationIsProtected(home, options, agentName, conversationName, sweep)) {
              conversationsProtected += 1;
              continue;
            }
            results = conversation.child(TOOL_RESULTS_DIRECTORY_NAME);
            const resultsPath = path.join(conversationPath, TOOL_RESULTS_DIRECTORY_NAME);
            const removed = await sweep.walk(results, resultsPath);
            results.close();
            if (removed && sweep.prune(conversation, TOOL_RESULTS_DIRECTORY_NAME, resultsPath)) {
              conversation.close();
              removedConversation =
                sweep.prune(agent, conversationName, conversationPath) || removedConversation;
            }
          } catch (error) {
            sweep.fail(conversationPath, "containment", error);
          } finally {
            results?.close();
            conversation?.close();
          }
          if (sweep.result().truncated) {
            break;
          }
        }
        agent.close();
        if (removedConversation) {
          sweep.prune(work, agentName, agentPath);
        }
      } catch (error) {
        sweep.fail(agentPath, "readdir", error);
      } finally {
        agent?.close();
      }
      if (sweep.result().truncated) {
        break;
      }
    }
    if (onlyIfDue && sweep.result().failures.length === 0 && !sweep.result().truncated) {
      work.stamp(SWEEP_STAMP_FILENAME, options.now);
    }
  } catch (error) {
    if (missingSweepPath(error)) {
      return result("no-work-directory");
    }
    sweep.fail(workPath, "containment", error);
  } finally {
    work?.close();
    home?.close();
  }
  if (sweep.result().failures.length > 0) {
    logger.warn("Tool-result sweep could not remove some paths", {
      failureCount: sweep.result().failures.length,
      firstOperation: sweep.result().failures[0]?.operation,
    });
  }
  logger.debug("Tool-result sweep finished", {
    ...sweep.result(),
    failures: undefined,
    conversationsVisited,
    conversationsProtected,
  });
  return result();
}

/** Sweeps abandoned result directories under descriptor-anchored Jazz home and work handles. */
export async function sweepOrphanedToolResults(
  options: ToolResultRetentionOptions,
): Promise<ToolResultRetentionResult> {
  return (
    (await runSweep(options, false)) ?? {
      skipped: "disabled",
      conversationsVisited: 0,
      conversationsProtected: 0,
      sweep: EMPTY_SWEEP,
    }
  );
}

/** Writes a due stamp only after an untruncated, successful sweep; never follows its pathname. */
export async function sweepToolResultsIfDue(
  options: ToolResultRetentionOptions,
): Promise<ToolResultRetentionResult | undefined> {
  return runSweep(options, true);
}

export interface ScheduleToolResultSweepOptions {
  /** Re-discovered for each run, including sandboxes created after startup. */
  readonly jazzHomes: () => readonly string[];
  /** Read when the sweep fires, so a setting changed meanwhile applies. */
  readonly retentionDays: () => number;
  readonly openConversations?: () => ReadonlySet<string>;
  readonly startupDelayMs?: number;
  /** When set, the sweep is attempted again at this interval for a long-lived process. */
  readonly repeatEveryMs?: number;
  readonly logger?: ToolResultSweepLogger;
}

let scheduledInThisProcess = false;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
let repeatTimer: ReturnType<typeof setInterval> | undefined;

/** Test hook: forget that a sweep was scheduled. */
export function resetToolResultSweepSchedule(): void {
  scheduledInThisProcess = false;
  if (startupTimer !== undefined) {
    clearTimeout(startupTimer);
  }
  if (repeatTimer !== undefined) {
    clearInterval(repeatTimer);
  }
  startupTimer = undefined;
  repeatTimer = undefined;
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
    for (const jazzHome of options.jazzHomes()) {
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
  let running = false;
  const runSafely = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      logger.warn("Tool-result sweep discovery failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  startupTimer = setTimeout(() => {
    void runSafely();
    if (options.repeatEveryMs !== undefined) {
      repeatTimer = setInterval(() => void runSafely(), options.repeatEveryMs);
      repeatTimer.unref();
    }
  }, options.startupDelayMs ?? TOOL_RESULT_SWEEP_STARTUP_DELAY_MS);
  startupTimer.unref();
  logger.debug("Tool-result sweep scheduled", {
    startupDelayMs: options.startupDelayMs ?? TOOL_RESULT_SWEEP_STARTUP_DELAY_MS,
  });
  return true;
}
