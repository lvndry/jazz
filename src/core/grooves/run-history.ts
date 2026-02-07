import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import {
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
  MAX_RUN_HISTORY_RECORDS,
} from "@/core/constants/agent";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

/**
 * Record of a single workflow run.
 */
export interface GrooveRunRecord {
  readonly grooveName: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed";
  readonly error?: string;
  readonly triggeredBy: "manual" | "scheduled";
}

/**
 * Get the path to the run history file.
 */
function getHistoryPath(): string {
  return path.join(getUserDataDirectory(), "run-history.json");
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
  return path.join(getUserDataDirectory(), "run-history.lock");
}

/**
 * Acquire a file lock with retry logic.
 * Uses mkdir as an atomic lock primitive (fails if exists).
 */
function acquireLock(
  lockPath: string,
  maxRetries = FILE_LOCK_MAX_RETRIES,
  retryDelayMs = FILE_LOCK_RETRY_DELAY_MS,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = yield* Effect.tryPromise(() => fs.mkdir(lockPath, { recursive: false })).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      );

      if (result) {
        return;
      }

      // Check if lock is stale
      const stat = yield* Effect.tryPromise(() => fs.stat(lockPath)).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );

      if (stat && Date.now() - stat.mtimeMs > FILE_LOCK_TIMEOUT_MS) {
        // Remove stale lock
        yield* Effect.tryPromise(() => fs.rmdir(lockPath)).pipe(
          Effect.catchAll(() => Effect.void),
        );
        continue;
      }

      // Wait before retry
      yield* Effect.sleep(retryDelayMs);
    }

    return yield* Effect.fail(new Error("Failed to acquire run history lock after retries"));
  });
}

/**
 * Release the file lock.
 */
function releaseLock(lockPath: string): Effect.Effect<void, never> {
  return Effect.tryPromise(() => fs.rmdir(lockPath)).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Execute an operation with file locking.
 */
function withLock<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E | Error> {
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
export function loadRunHistory(): Effect.Effect<GrooveRunRecord[], Error> {
  return Effect.gen(function* () {
    const historyPath = getHistoryPath();

    const content = yield* Effect.tryPromise(() => fs.readFile(historyPath, "utf-8")).pipe(
      Effect.catchAll((unknownErr) => {
        const e =
          unknownErr &&
          typeof unknownErr === "object" &&
          "error" in unknownErr &&
          (unknownErr as { error: unknown }).error;
        const code = e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : "";
        if (code === "ENOENT") return Effect.succeed("");
        return Effect.fail(
          unknownErr instanceof Error ? unknownErr : new Error(String(unknownErr)),
        );
      }),
    );

    if (content === "") return [];

    try {
      const history = JSON.parse(content) as GrooveRunRecord[];
      return Array.isArray(history) ? history : [];
    } catch {
      return [];
    }
  });
}

/**
 * Save the run history to disk using atomic write (temp file + rename).
 */
function saveRunHistory(history: GrooveRunRecord[]): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const historyPath = getHistoryPath();
    const dir = path.dirname(historyPath);
    const tempPath = path.join(dir, `.run-history-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

    yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true }));
    yield* Effect.tryPromise(() => fs.writeFile(tempPath, JSON.stringify(history, null, 2)));
    yield* Effect.tryPromise(() => fs.rename(tempPath, historyPath)).pipe(
      Effect.tapError(() => Effect.tryPromise(() => fs.unlink(tempPath)).pipe(Effect.catchAll(() => Effect.void))),
    );
  });
}

/**
 * Add a new run record to the history.
 * Keeps only the last N records to prevent unbounded growth.
 * Uses file locking to prevent race conditions.
 */
export function addRunRecord(record: GrooveRunRecord): Effect.Effect<void, Error> {
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
  grooveName: string,
  update: Partial<GrooveRunRecord>,
): Effect.Effect<void, Error> {
  return withLock(
    Effect.gen(function* () {
      const history = yield* loadRunHistory();

      // Find the most recent record for this workflow that is still running
      for (let i = history.length - 1; i >= 0; i--) {
        const record = history[i];
        if (record && record.grooveName === grooveName && record.status === "running") {
          history[i] = { ...record, ...update };
          yield* saveRunHistory(history);
          return;
        }
      }
    }),
  );
}

/**
 * Get run history for a specific groove.
 */
export function getGrooveHistory(
  grooveName: string,
): Effect.Effect<GrooveRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.filter((r) => r.grooveName === grooveName);
  });
}

/**
 * Get the most recent runs (across all workflows).
 */
export function getRecentRuns(limit = 20): Effect.Effect<GrooveRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.slice(-limit).reverse();
  });
}
