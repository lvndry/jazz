/**
 * Persists and queries the log of workflow runs (`run-history.json`), used to
 * decide whether a scheduled workflow needs catch-up and to display recent
 * run status.
 */
import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { MAX_RUN_HISTORY_RECORDS } from "@/core/constants/agent";
import { getGlobalUserDataDirectory } from "@/core/utils/paths";
import { readStateFile, recordListKind, writeStateFile } from "@/core/utils/state-file";
import { withLock } from "@/core/utils/storage";

/**
 * Record of a single workflow run.
 */
export interface WorkflowRunRecord {
  readonly workflowName: string;
  /**
   * Which schedule fired this run (`default`, `monthly`, ...), or `manual` for a
   * terminal run. Missing on records written before schedules had labels.
   */
  readonly scheduleLabel?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed" | "skipped";
  readonly error?: string;
  readonly triggeredBy: "manual" | "scheduled";
  readonly costUSD?: number;
  readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number };
}

/** Label of a run started by hand rather than by a schedule. */
export const MANUAL_RUN_LABEL = "manual";

/**
 * The schedule label a record belongs to, reading pre-label records the way the
 * migration does: a scheduled one was the workflow's single `default` schedule.
 */
export function runScheduleLabel(record: WorkflowRunRecord): string {
  if (record.scheduleLabel !== undefined) return record.scheduleLabel;
  return record.triggeredBy === "scheduled" ? "default" : MANUAL_RUN_LABEL;
}

/**
 * When this workflow last completed under this label. Each schedule keeps its own
 * marker, so a monthly recap covers the whole month even when the weekly one ran
 * in between.
 */
export function lastCompletedRunAt(
  history: readonly WorkflowRunRecord[],
  workflowName: string,
  label: string,
): string | undefined {
  let latest: string | undefined;
  for (const record of history) {
    if (record.workflowName !== workflowName || record.status !== "completed") continue;
    if (runScheduleLabel(record) !== label) continue;
    const completedAt = record.completedAt ?? record.startedAt;
    if (latest === undefined || completedAt > latest) latest = completedAt;
  }
  return latest;
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

const WorkflowRunRecordSchema: z.ZodType<WorkflowRunRecord> = z.object({
  workflowName: z.string().min(1),
  scheduleLabel: z.string().exactOptional(),
  startedAt: z.string(),
  completedAt: z.string().exactOptional(),
  status: z.enum(["running", "completed", "failed", "skipped"]),
  error: z.string().exactOptional(),
  triggeredBy: z.enum(["manual", "scheduled"]),
  costUSD: z.number().exactOptional(),
  tokenUsage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).exactOptional(),
});

const RUN_HISTORY_FILE_KIND = recordListKind("workflow runs", "runs", WorkflowRunRecordSchema);

/** Read the history while holding its lock; a corrupt file is quarantined and reads as empty. */
function readRunHistoryLocked(): Effect.Effect<WorkflowRunRecord[], Error> {
  return readStateFile(getHistoryPath(), RUN_HISTORY_FILE_KIND, { onCorrupt: "quarantine" }).pipe(
    Effect.map((history) => history ?? []),
  );
}

/**
 * Load the run history from disk: empty when no workflow has run yet, or when the file was
 * corrupt and has been moved aside. A history written by a newer Jazz fails rather than reading
 * as empty, because an empty history makes every schedule look missed.
 */
export function loadRunHistory(): Effect.Effect<WorkflowRunRecord[], Error> {
  return withLock(getLockPath(), readRunHistoryLocked());
}

/**
 * Save the run history to disk durably (temp file, fsync, rename). Callers hold the lock.
 */
function saveRunHistory(history: WorkflowRunRecord[]): Effect.Effect<void, Error> {
  return writeStateFile(getHistoryPath(), RUN_HISTORY_FILE_KIND, history);
}

/**
 * Add a new run record to the history.
 * Keeps only the last N records to prevent unbounded growth.
 * Uses file locking to prevent race conditions.
 */
export function addRunRecord(record: WorkflowRunRecord): Effect.Effect<void, Error> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const history = yield* readRunHistoryLocked();

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
): Effect.Effect<void, Error> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const history = yield* readRunHistoryLocked();

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
): Effect.Effect<WorkflowRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.filter((r) => r.workflowName === workflowName);
  });
}

/**
 * Get the most recent runs (across all workflows), ordered oldest to newest.
 */
export function getRecentRuns(limit = 20): Effect.Effect<WorkflowRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.slice(-limit);
  });
}

/**
 * Load run history from both local and global directories (dedupe not required).
 * Useful when scheduled runs execute in a different runtime context.
 */
