/**
 * Persists and queries the log of workflow runs (`run-history.json`), used to
 * decide whether a scheduled workflow needs catch-up and to display recent
 * run status.
 *
 * Each record has an id; a run's own updates are keyed by it, so two runs of the
 * same workflow never finish each other's records. A `running` record names the
 * process running it, so a record whose process died is marked `interrupted`
 * instead of looking busy forever. History is kept per schedule (the last
 * {@link MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE} runs of each workflow label), so a
 * frequent workflow cannot evict another's record and make it run again. Deciding
 * a slot and recording its run happen in one locked step
 * ({@link recordRunsUnderLock}), so two processes cannot both claim a slot.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { getGlobalUserDataDirectory } from "@/core/utils/paths";
import { currentProcessOwner, localOwnerStatus, type ProcessOwner } from "@/core/utils/process";
import { readStateFile, recordListKind, writeStateFile } from "@/core/utils/state-file";
import { withLock } from "@/core/utils/storage";

/** Runs kept per workflow schedule label. */
export const MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE = 20;

export type WorkflowRunStatus = "running" | "completed" | "failed" | "skipped" | "interrupted";

/**
 * Record of a single workflow run.
 */
export interface WorkflowRunRecord {
  readonly id: string;
  readonly workflowName: string;
  /**
   * Which schedule fired this run (`default`, `monthly`, ...), or `manual` for a
   * terminal run. Missing on records written before schedules had labels.
   */
  readonly scheduleLabel?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  /**
   * `skipped` is a slot that was not run: missed by more than its catch-up window,
   * or cancelled at the agent picker. `interrupted` is a run whose process exited
   * before it finished.
   */
  readonly status: WorkflowRunStatus;
  readonly error?: string;
  readonly triggeredBy: "manual" | "scheduled";
  /** The process executing a `running` record. */
  readonly owner?: ProcessOwner;
  readonly costUSD?: number;
  readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number };
}

/** A record to add; the history assigns its id and, while it is running, its owner. */
export type NewWorkflowRunRecord = Omit<WorkflowRunRecord, "id" | "owner">;

/** What a run reports about itself. Any status other than `running` drops the owner. */
export type WorkflowRunUpdate = Partial<
  Pick<WorkflowRunRecord, "status" | "completedAt" | "error" | "costUSD" | "tokenUsage">
>;

/** Label of a run started by hand rather than by a schedule. */
export const MANUAL_RUN_LABEL = "manual";

type ScheduleFields = Pick<WorkflowRunRecord, "workflowName" | "scheduleLabel" | "triggeredBy">;

/**
 * The schedule label a record belongs to, reading pre-label records the way the
 * migration does: a scheduled one was the workflow's single `default` schedule.
 */
export function runScheduleLabel(record: Omit<ScheduleFields, "workflowName">): string {
  if (record.scheduleLabel !== undefined) return record.scheduleLabel;
  return record.triggeredBy === "scheduled" ? "default" : MANUAL_RUN_LABEL;
}

/** `<workflow>/<label>`, the id of the schedule a record belongs to. */
export function runScheduleKey(record: ScheduleFields): string {
  return `${record.workflowName}/${runScheduleLabel(record)}`;
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

function getHistoryPath(): string {
  return path.join(getGlobalUserDataDirectory(), "run-history.json");
}

/**
 * Return the run history file path (for diagnostics when history is empty).
 */
export function getRunHistoryFilePath(): string {
  return getHistoryPath();
}

function getLockPath(): string {
  return path.join(getGlobalUserDataDirectory(), "run-history.lock");
}

const ProcessOwnerSchema: z.ZodType<ProcessOwner> = z.object({
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.number().exactOptional(),
});

const WorkflowRunRecordSchema: z.ZodType<WorkflowRunRecord> = z.object({
  id: z.string().min(1),
  workflowName: z.string().min(1),
  scheduleLabel: z.string().exactOptional(),
  startedAt: z.string(),
  completedAt: z.string().exactOptional(),
  status: z.enum(["running", "completed", "failed", "skipped", "interrupted"]),
  error: z.string().exactOptional(),
  triggeredBy: z.enum(["manual", "scheduled"]),
  owner: ProcessOwnerSchema.exactOptional(),
  costUSD: z.number().exactOptional(),
  tokenUsage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).exactOptional(),
});

/**
 * Version 2 added record ids, owners and the `interrupted` status. An older record gets an id
 * made from what identified it before: its workflow and start time.
 */
const RUN_HISTORY_SCHEMA_VERSION = 2;

function migrateRunRecord(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || "id" in entry) {
    return entry;
  }
  const legacy = entry as { readonly workflowName?: unknown; readonly startedAt?: unknown };
  return { ...entry, id: `legacy-${String(legacy.workflowName)}-${String(legacy.startedAt)}` };
}

const RUN_HISTORY_FILE_KIND = recordListKind("workflow runs", "runs", WorkflowRunRecordSchema, {
  schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
  migrate: migrateRunRecord,
});

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

/** The last {@link MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE} records of each schedule, in order. */
export function trimPerSchedule(history: readonly WorkflowRunRecord[]): WorkflowRunRecord[] {
  const keptPerSchedule = new Map<string, number>();
  const kept: WorkflowRunRecord[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const record = history[index];
    if (record === undefined) {
      continue;
    }
    const key = runScheduleKey(record);
    const count = keptPerSchedule.get(key) ?? 0;
    if (count >= MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE) {
      continue;
    }
    keptPerSchedule.set(key, count + 1);
    kept.push(record);
  }
  return kept.reverse();
}

/** Save the history durably, keeping the last runs of each schedule. Callers hold the lock. */
function saveRunHistory(history: readonly WorkflowRunRecord[]): Effect.Effect<void, Error> {
  return writeStateFile(getHistoryPath(), RUN_HISTORY_FILE_KIND, trimPerSchedule(history));
}

function withoutOwner(record: WorkflowRunRecord): WorkflowRunRecord {
  const { owner: _owner, ...rest } = record;
  return rest;
}

function materialize(record: NewWorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    id: randomUUID(),
    ...(record.status === "running" ? { owner: currentProcessOwner() } : {}),
  };
}

/**
 * `running` records whose process is gone, marked `interrupted`. A record written before
 * owners were kept is left as it is: nothing says whether its process is alive.
 */
function interruptAbandoned(
  history: readonly WorkflowRunRecord[],
  now: Date,
): { readonly history: WorkflowRunRecord[]; readonly interrupted: number } {
  let interrupted = 0;
  const next = history.map((record) => {
    if (
      record.status !== "running" ||
      record.owner === undefined ||
      localOwnerStatus(record.owner) !== "gone"
    ) {
      return record;
    }
    interrupted += 1;
    return {
      ...withoutOwner(record),
      status: "interrupted" as const,
      completedAt: now.toISOString(),
      error: "The process running this workflow exited before it finished.",
    };
  });
  return { history: next, interrupted };
}

/**
 * Mark `running` records whose process is gone as `interrupted`, and return how many were.
 * Called when a process that runs workflows starts; every scheduling decision does it too.
 */
export function markInterruptedRuns(now: Date = new Date()): Effect.Effect<number, Error> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const { history, interrupted } = interruptAbandoned(yield* readRunHistoryLocked(), now);
      if (interrupted > 0) {
        yield* saveRunHistory(history);
      }
      return interrupted;
    }),
  );
}

/**
 * Decide and record in one locked step: `select` sees the whole history (abandoned runs
 * already marked `interrupted`) and returns the records to add, which are written before the
 * lock is released. Returns them with their ids, so the caller runs exactly the slots it claimed.
 */
export function recordRunsUnderLock(
  select: (history: readonly WorkflowRunRecord[]) => readonly NewWorkflowRunRecord[],
  now: Date = new Date(),
): Effect.Effect<WorkflowRunRecord[], Error> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const { history, interrupted } = interruptAbandoned(yield* readRunHistoryLocked(), now);
      const added = select(history).map(materialize);
      if (added.length > 0 || interrupted > 0) {
        yield* saveRunHistory([...history, ...added]);
      }
      return added;
    }),
  );
}

/** Add one run record and return it with its id. */
export function addRunRecord(
  record: NewWorkflowRunRecord,
): Effect.Effect<WorkflowRunRecord, Error> {
  return recordRunsUnderLock(() => [record]).pipe(
    Effect.flatMap((added) =>
      added[0] !== undefined
        ? Effect.succeed(added[0])
        : Effect.fail(new Error("The workflow run record was not written.")),
    ),
  );
}

/** Update the run with this id. A record already trimmed away is not an error. */
export function updateRunRecord(
  runId: string,
  update: WorkflowRunUpdate,
): Effect.Effect<void, Error> {
  return withLock(
    getLockPath(),
    Effect.gen(function* () {
      const history = yield* readRunHistoryLocked();
      const index = history.findIndex((record) => record.id === runId);
      const record = history[index];
      if (record === undefined) {
        return;
      }
      const stillRunning = (update.status ?? record.status) === "running";
      history[index] = { ...(stillRunning ? record : withoutOwner(record)), ...update };
      yield* saveRunHistory(history);
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
