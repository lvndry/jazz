/**
 * Persists and queries the log of workflow runs (`run-history.json`), used to
 * decide whether a scheduled workflow needs catch-up and to display recent
 * run status.
 */
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { MAX_RUN_HISTORY_RECORDS } from "@/core/constants/agent";
import { getGlobalUserDataDirectory } from "@/core/utils/paths";
import { withLock, writeFileStringAtomic } from "@/core/utils/storage";

/**
 * Record of a single workflow run.
 */
export interface WorkflowRunRecord {
  readonly workflowName: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed" | "skipped";
  readonly error?: string;
  readonly triggeredBy: "manual" | "scheduled";
  readonly costUSD?: number;
  readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number };
}

/**
 * Get the path to the run history file.
 */
function getHistoryPath(): string {
  return path.join(getGlobalUserDataDirectory(), "run-history.json");
}

/**
 * Return the run history file path (for diagnostics when history is empty).
 */
export function getRunHistoryFilePath(): string {
  return getHistoryPath();
}

/**
 * Get the path to the lock file.
 */
function getLockPath(): string {
  return path.join(getGlobalUserDataDirectory(), "run-history.lock");
}

/**
 * Load the run history from disk.
 * Returns empty array if the file does not exist (e.g. no workflows run yet) or is invalid.
 */
export function loadRunHistory(): Effect.Effect<WorkflowRunRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const historyPath = getHistoryPath();

    const content = yield* fs
      .readFileString(historyPath)
      .pipe(
        Effect.catchAll((e) =>
          e &&
          typeof e === "object" &&
          "_tag" in e &&
          (e as { _tag: string })._tag === "SystemError" &&
          (e as { reason?: string }).reason === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(e instanceof Error ? e : new Error(String(e))),
        ),
      );

    if (content === "") return [];

    try {
      const history = JSON.parse(content) as WorkflowRunRecord[];
      return Array.isArray(history) ? history : [];
    } catch {
      return [];
    }
  });
}

/**
 * Save the run history to disk using atomic write (temp file + rename).
 */
function saveRunHistory(
  history: WorkflowRunRecord[],
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const historyPath = getHistoryPath();
    yield* writeFileStringAtomic(fs, historyPath, JSON.stringify(history, null, 2), {
      tempPrefix: "run-history",
    });
  });
}

/**
 * Add a new run record to the history.
 * Keeps only the last N records to prevent unbounded growth.
 * Uses file locking to prevent race conditions.
 */
export function addRunRecord(
  record: WorkflowRunRecord,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const history = yield* loadRunHistory();

      // Add the new record
      history.push(record);

      // Keep only the most recent records
      const trimmed = history.slice(-MAX_RUN_HISTORY_RECORDS);

      yield* saveRunHistory(trimmed);
    }),
  );
}

/**
 * Update the most recent run record for a workflow.
 * Uses file locking to prevent race conditions.
 */
export function updateLatestRunRecord(
  workflowName: string,
  update: Partial<WorkflowRunRecord>,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const history = yield* loadRunHistory();

      // Find the most recent record for this workflow that is still running
      for (let i = history.length - 1; i >= 0; i--) {
        const record = history[i];
        if (record && record.workflowName === workflowName && record.status === "running") {
          history[i] = { ...record, ...update };
          yield* saveRunHistory(history);
          return;
        }
      }
    }),
  );
}

/**
 * Get run history for a specific workflow.
 */
export function getWorkflowHistory(
  workflowName: string,
): Effect.Effect<WorkflowRunRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.filter((r) => r.workflowName === workflowName);
  });
}

/**
 * Get the most recent runs (across all workflows), ordered oldest to newest.
 */
export function getRecentRuns(
  limit = 20,
): Effect.Effect<WorkflowRunRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.slice(-limit);
  });
}

/**
 * Load run history from both local and global directories (dedupe not required).
 * Useful when scheduled runs execute in a different runtime context.
 */
