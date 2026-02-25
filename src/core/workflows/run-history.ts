import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import {
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
  MAX_RUN_HISTORY_RECORDS,
} from "@/core/constants/agent";
import { getGlobalUserDataDirectory } from "@/core/utils/runtime-detection";

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
 * Acquire a file lock with retry logic.
 * Uses mkdir as an atomic lock primitive (fails if exists).
 */
function acquireLock(
  lockPath: string,
  maxRetries = FILE_LOCK_MAX_RETRIES,
  retryDelayMs = FILE_LOCK_RETRY_DELAY_MS,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = yield* fs.makeDirectory(lockPath, { recursive: false }).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      );

      if (result) {
        return;
      }

      const statResult = yield* fs.stat(lockPath).pipe(Effect.option);
      const stat = Option.getOrNull(statResult);

      const mtimeMs = Option.match(stat?.mtime ?? Option.none(), {
        onNone: () => 0,
        onSome: (d) => d.getTime(),
      });
      if (stat && Date.now() - mtimeMs > FILE_LOCK_TIMEOUT_MS) {
        yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        continue;
      }

      yield* Effect.sleep(retryDelayMs);
    }

    return yield* Effect.fail(new Error("Failed to acquire run history lock after retries"));
  });
}

/**
 * Release the file lock.
 * Uses recursive:true because the lock is a directory and Node's fs.rm
 */
function releaseLock(lockPath: string): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
  });
}

/**
 * Execute an operation with file locking.
 */
function withLock<A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> {
  const lockPath = getLockPath();
  return Effect.acquireUseRelease(
    acquireLock(lockPath),
    () => operation,
    () => releaseLock(lockPath),
  );
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
    const dir = path.dirname(historyPath);
    const tempPath = path.join(
      dir,
      `.run-history-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs
      .writeFileString(tempPath, JSON.stringify(history, null, 2))
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs.rename(tempPath, historyPath).pipe(
      Effect.tapError(() => fs.remove(tempPath).pipe(Effect.catchAll(() => Effect.void))),
      Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
    );
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
 * Get the most recent runs (across all workflows).
 */
export function getRecentRuns(
  limit = 20,
): Effect.Effect<WorkflowRunRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.slice(-limit).reverse();
  });
}

/**
 * Load run history from both local and global directories (dedupe not required).
 * Useful when scheduled runs execute in a different runtime context.
 */
