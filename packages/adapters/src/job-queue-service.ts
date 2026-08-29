/**
 * Implements `JobQueueService`: fan-out/fan-in background job batches persisted as one
 * lock-guarded JSON file per batch, under `<agentId>/<batchId>.json`, using the same
 * directory-mutex (`withLock`) and atomic-write (`writeFileStringAtomic`) primitives as
 * `WakeTriggerServiceImpl`. A batch's completion is fanned in and resumed the same way a wake
 * trigger fires — see `packages/adapters/src/daemon/job-worker.ts` and `trigger-runner.ts`.
 *
 * Two families of exports live here:
 * - the `JobQueueService` methods (`enqueueBatch`, `getBatch`, `listActiveBatches`,
 *   `cancelBatch`), called from tools inside a live agent run
 * - free functions used only by the daemon's worker loop (`claimDueJobs`, `completeJob`,
 *   `reclaimExpiredLeases`, `listAgentIdsWithActiveBatches`) — these never run inside a tool
 *   call, so they aren't part of the service interface
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import {
  DEFAULT_BACKOFF_INITIAL_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_CONCURRENCY_CAP,
  DEFAULT_MAX_ATTEMPTS,
  JOB_COMMAND_MAX_LENGTH,
  JOB_LEASE_TIMEOUT_MS,
  JOB_REASON_MAX_LENGTH,
  MAX_ACTIVE_BATCHES_PER_AGENT,
  MAX_CONCURRENCY_CAP,
  MAX_JOBS_PER_BATCH,
  MAX_MAX_ATTEMPTS,
} from "@jazz/core/constants/job-queue";
import type {
  CancelBatchOutcome,
  EnqueueBatchJobInput,
  EnqueueBatchOptions,
  EnqueueBatchOutcome,
  JobBatchRecord,
  JobQueueService,
  JobRecord,
} from "@jazz/core/interfaces/job-queue-service";
import { JobQueueServiceTag } from "@jazz/core/interfaces/job-queue-service";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import {
  requireValidAgentId,
  requireValidStorageKey,
  withLock,
  writeFileStringAtomic,
} from "@jazz/core/utils/storage";
import { Effect, Layer } from "effect";

/** Raised for guardrail violations — genuinely unexpected conditions, not tool-result-shaped errors. */
export class JobQueueGuardrailViolation extends Error {}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Exponential backoff with jitter, computed synchronously from persisted state rather than
 * driven by Effect's `Schedule` — a `Schedule` is built to drive a *live* retry loop, and there
 * is no in-process loop here: the delay just needs to become the `nextAttemptAt` a future daemon
 * tick (possibly after a restart) compares against `Date.now()`.
 */
export function computeBackoffDelayMs(
  backoff: { readonly initialMs: number; readonly maxMs: number },
  attempt: number,
): number {
  const exponential = backoff.initialMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, backoff.maxMs);
  const jitterFactor = 0.5 + Math.random(); // spread retries across [0.5x, 1.5x) of the target delay
  return Math.round(capped * jitterFactor);
}

function agentDirectory(baseDirectory: string, agentId: string): string {
  return path.join(baseDirectory, agentId);
}

function batchFilePath(baseDirectory: string, agentId: string, batchId: string): string {
  return path.join(agentDirectory(baseDirectory, agentId), `${batchId}.json`);
}

function batchLockPath(baseDirectory: string, agentId: string, batchId: string): string {
  return path.join(agentDirectory(baseDirectory, agentId), `${batchId}.lock`);
}

/** Guards the "count active batches, then create a new one" sequence against concurrent enqueues. */
function agentEnqueueLockPath(baseDirectory: string, agentId: string): string {
  return path.join(baseDirectory, `${agentId}.enqueue.lock`);
}

function readBatchFile(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<JobBatchRecord | null, Error> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return null;

    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll((e) => Effect.fail(toError(e))));
    try {
      return JSON.parse(content) as JobBatchRecord;
    } catch {
      return null;
    }
  });
}

function writeBatchFile(
  fs: FileSystem.FileSystem,
  filePath: string,
  batch: JobBatchRecord,
): Effect.Effect<void, Error> {
  return writeFileStringAtomic(fs, filePath, `${JSON.stringify(batch, null, 2)}\n`, {
    tempPrefix: "job-batch",
  });
}

function isTerminalStatus(status: JobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export interface JobQueueServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/job-batches (or $JAZZ_HOME/job-batches). */
  readonly baseJobBatchDirectory?: string;
}

export class JobQueueServiceImpl implements JobQueueService {
  readonly baseJobBatchDirectory: string;

  constructor(options?: JobQueueServiceImplOptions) {
    this.baseJobBatchDirectory =
      options?.baseJobBatchDirectory ?? path.join(getJazzHomeDirectory(), "job-batches");
  }

  readonly enqueueBatch: JobQueueService["enqueueBatch"] = (
    agentId: string,
    conversationId: string,
    jobs: readonly EnqueueBatchJobInput[],
    options: EnqueueBatchOptions,
  ) => {
    const baseJobBatchDirectory = this.baseJobBatchDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, JobQueueGuardrailViolation);

      if (jobs.length === 0) {
        return {
          success: false,
          message: "A batch needs at least one job.",
        } satisfies EnqueueBatchOutcome;
      }
      if (jobs.length > MAX_JOBS_PER_BATCH) {
        return {
          success: false,
          message: `Batch has ${jobs.length} jobs, exceeding the maximum of ${MAX_JOBS_PER_BATCH}.`,
        } satisfies EnqueueBatchOutcome;
      }
      for (const job of jobs) {
        const command = job.command.trim();
        if (command.length === 0) {
          return {
            success: false,
            message: "Every job needs a non-empty command.",
          } satisfies EnqueueBatchOutcome;
        }
        if (command.length > JOB_COMMAND_MAX_LENGTH) {
          return {
            success: false,
            message: `A job command is ${command.length} characters, exceeding the maximum of ${JOB_COMMAND_MAX_LENGTH}.`,
          } satisfies EnqueueBatchOutcome;
        }
      }
      if (options.reason.length > JOB_REASON_MAX_LENGTH) {
        return {
          success: false,
          message: `Batch reason is ${options.reason.length} characters, exceeding the maximum of ${JOB_REASON_MAX_LENGTH}.`,
        } satisfies EnqueueBatchOutcome;
      }

      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(agentDirectory(baseJobBatchDirectory, agentId), { recursive: true })
        .pipe(Effect.mapError(toError));

      const outcome = yield* withLock(
        agentEnqueueLockPath(baseJobBatchDirectory, agentId),
        Effect.gen(function* () {
          const agentDir = agentDirectory(baseJobBatchDirectory, agentId);
          const names = yield* fs
            .readDirectory(agentDir)
            .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
          const existingBatchIds = names
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -".json".length));

          let activeCount = 0;
          for (const existingBatchId of existingBatchIds) {
            const existing = yield* readBatchFile(
              fs,
              batchFilePath(baseJobBatchDirectory, agentId, existingBatchId),
            );
            if (existing !== null && existing.completedAt === null) activeCount++;
          }
          if (activeCount >= MAX_ACTIVE_BATCHES_PER_AGENT) {
            return {
              success: false,
              message:
                `You already have ${activeCount} active job batches, the maximum of ` +
                `${MAX_ACTIVE_BATCHES_PER_AGENT}. Wait for one to finish or cancel_batch one before enqueueing another.`,
            } satisfies EnqueueBatchOutcome;
          }

          const now = Date.now();
          const concurrencyCap = clamp(
            options.concurrencyCap ?? DEFAULT_CONCURRENCY_CAP,
            1,
            MAX_CONCURRENCY_CAP,
          );
          const maxAttempts = clamp(
            options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            1,
            MAX_MAX_ATTEMPTS,
          );
          const batchId = newId();

          const batch: JobBatchRecord = {
            id: batchId,
            agentId,
            conversationId,
            workingDir: options.workingDir,
            concurrencyCap,
            backoff: { initialMs: DEFAULT_BACKOFF_INITIAL_MS, maxMs: DEFAULT_BACKOFF_MAX_MS },
            reason: options.reason,
            createdAt: now,
            completedAt: null,
            jobs: jobs.map((job) => ({
              id: newId(),
              command: job.command.trim(),
              status: "pending",
              attempt: 0,
              maxAttempts,
              nextAttemptAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              result: null,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            })),
          };

          yield* writeBatchFile(fs, batchFilePath(baseJobBatchDirectory, agentId, batchId), batch);
          return { success: true, batch } satisfies EnqueueBatchOutcome;
        }),
      );

      return outcome;
    });
  };

  readonly getBatch: JobQueueService["getBatch"] = (agentId: string, batchId: string) => {
    const baseJobBatchDirectory = this.baseJobBatchDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, JobQueueGuardrailViolation);
      yield* requireValidStorageKey(batchId, "batch id", JobQueueGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      return yield* readBatchFile(fs, batchFilePath(baseJobBatchDirectory, agentId, batchId));
    });
  };

  readonly listActiveBatches: JobQueueService["listActiveBatches"] = (agentId: string) => {
    const baseJobBatchDirectory = this.baseJobBatchDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, JobQueueGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      const agentDir = agentDirectory(baseJobBatchDirectory, agentId);
      const exists = yield* fs.exists(agentDir).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) return [];

      const names = yield* fs
        .readDirectory(agentDir)
        .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
      const batchIds = names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));

      const batches: JobBatchRecord[] = [];
      for (const batchId of batchIds) {
        const batch = yield* readBatchFile(
          fs,
          batchFilePath(baseJobBatchDirectory, agentId, batchId),
        );
        if (batch !== null) batches.push(batch);
      }
      return batches.sort((left, right) => right.createdAt - left.createdAt);
    });
  };

  readonly cancelBatch: JobQueueService["cancelBatch"] = (agentId: string, batchId: string) => {
    const baseJobBatchDirectory = this.baseJobBatchDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, JobQueueGuardrailViolation);
      yield* requireValidStorageKey(batchId, "batch id", JobQueueGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;

      return yield* withLock(
        batchLockPath(baseJobBatchDirectory, agentId, batchId),
        Effect.gen(function* () {
          const filePath = batchFilePath(baseJobBatchDirectory, agentId, batchId);
          const batch = yield* readBatchFile(fs, filePath);
          if (batch === null) {
            return {
              success: false,
              message: `No job batch found with id "${batchId}".`,
            } satisfies CancelBatchOutcome;
          }
          if (batch.completedAt !== null) {
            return {
              success: false,
              message: "That batch has already finished.",
            } satisfies CancelBatchOutcome;
          }

          const now = Date.now();
          const jobs = batch.jobs.map((job) =>
            job.status === "pending"
              ? { ...job, status: "cancelled" as const, updatedAt: now }
              : job,
          );
          const allTerminal = jobs.every((job) => isTerminalStatus(job.status));
          const updated: JobBatchRecord = {
            ...batch,
            jobs,
            completedAt: allTerminal ? now : batch.completedAt,
          };
          yield* writeBatchFile(fs, filePath, updated);

          return {
            success: true,
            message: jobs.some((job) => job.status === "running")
              ? "Pending jobs cancelled. Jobs already running will finish naturally."
              : "Batch cancelled.",
          } satisfies CancelBatchOutcome;
        }),
      );
    });
  };
}

export function createJobQueueServiceLayer(
  options?: JobQueueServiceImplOptions,
): Layer.Layer<JobQueueService> {
  return Layer.succeed(JobQueueServiceTag, new JobQueueServiceImpl(options));
}

// ---------------------------------------------------------------------------------------------
// Daemon-only worker functions — never called from a tool handler.
// ---------------------------------------------------------------------------------------------

/** Every agentId with a job-batches directory — the daemon checks each for claimable work. */
export function listAgentIdsWithActiveBatches(
  baseJobBatchDirectory: string,
): Effect.Effect<readonly string[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(baseJobBatchDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return [];

    const names = yield* fs
      .readDirectory(baseJobBatchDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    // Per-agent enqueue locks (`<agentId>.enqueue.lock`) live alongside the per-agent
    // subdirectories in this same directory — filter those out.
    return names.filter((name) => !name.endsWith(".lock"));
  });
}

export interface ClaimedJob {
  readonly agentId: string;
  readonly batchId: string;
  readonly jobId: string;
  readonly command: string;
  readonly workingDir: string;
  readonly attempt: number;
}

/**
 * Claim up to `count` pending, due, unleased jobs across one agent's active batches. Each batch
 * file's read-modify-write happens inside that batch's own lock, so two daemon ticks (or two
 * workers within one tick) can never claim the same job twice.
 */
export function claimDueJobs(
  baseJobBatchDirectory: string,
  agentId: string,
  now: number,
  count: number,
  leaseOwner: string,
): Effect.Effect<readonly ClaimedJob[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDir = agentDirectory(baseJobBatchDirectory, agentId);
    const exists = yield* fs.exists(agentDir).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return [];

    const names = yield* fs
      .readDirectory(agentDir)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const batchIds = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));

    const claimed: ClaimedJob[] = [];
    for (const batchId of batchIds) {
      if (claimed.length >= count) break;
      const remaining = count - claimed.length;

      const claimedInBatch = yield* withLock(
        batchLockPath(baseJobBatchDirectory, agentId, batchId),
        Effect.gen(function* () {
          const filePath = batchFilePath(baseJobBatchDirectory, agentId, batchId);
          const batch = yield* readBatchFile(fs, filePath);
          if (batch === null || batch.completedAt !== null) return [] as ClaimedJob[];

          const currentlyRunning = batch.jobs.filter((job) => job.status === "running").length;
          const batchBudget = Math.max(0, batch.concurrencyCap - currentlyRunning);
          const claimBudget = Math.min(remaining, batchBudget);

          const claimedHere: ClaimedJob[] = [];
          const jobs = batch.jobs.map((job) => {
            if (
              claimedHere.length < claimBudget &&
              job.status === "pending" &&
              job.nextAttemptAt <= now
            ) {
              claimedHere.push({
                agentId,
                batchId,
                jobId: job.id,
                command: job.command,
                workingDir: batch.workingDir,
                attempt: job.attempt,
              });
              return {
                ...job,
                status: "running" as const,
                leaseOwner,
                leaseExpiresAt: now + JOB_LEASE_TIMEOUT_MS,
                updatedAt: now,
              };
            }
            return job;
          });

          if (claimedHere.length > 0) {
            yield* writeBatchFile(fs, filePath, { ...batch, jobs });
          }
          return claimedHere;
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed([] as ClaimedJob[])));

      claimed.push(...claimedInBatch);
    }

    return claimed;
  });
}

export interface JobRunOutcome {
  readonly success: boolean;
  readonly result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  } | null;
  readonly error: string | null;
}

export interface CompleteJobResult {
  readonly batchNowComplete: boolean;
  readonly batch: JobBatchRecord | null;
}

function applyOutcomeToJob(
  job: JobRecord,
  batch: JobBatchRecord,
  outcome: JobRunOutcome,
  now: number,
): JobRecord {
  const attempt = job.attempt + 1;
  if (outcome.success) {
    return {
      ...job,
      status: "succeeded",
      attempt,
      result: outcome.result,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
  }

  if (attempt < job.maxAttempts) {
    return {
      ...job,
      status: "pending",
      attempt,
      nextAttemptAt: now + computeBackoffDelayMs(batch.backoff, attempt),
      result: outcome.result,
      lastError: outcome.error,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
  }

  return {
    ...job,
    status: "failed",
    attempt,
    result: outcome.result,
    lastError: outcome.error,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  };
}

/**
 * Record the outcome of a claimed job's execution, retrying with backoff if attempts remain, and
 * report whether this was the batch's last non-terminal job (i.e. fan-in should fire).
 */
export function completeJob(
  baseJobBatchDirectory: string,
  agentId: string,
  batchId: string,
  jobId: string,
  outcome: JobRunOutcome,
): Effect.Effect<CompleteJobResult, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* withLock(
      batchLockPath(baseJobBatchDirectory, agentId, batchId),
      Effect.gen(function* () {
        const filePath = batchFilePath(baseJobBatchDirectory, agentId, batchId);
        const batch = yield* readBatchFile(fs, filePath);
        if (batch === null)
          return { batchNowComplete: false, batch: null } satisfies CompleteJobResult;

        const now = Date.now();
        const wasAlreadyComplete = batch.completedAt !== null;
        const jobs = batch.jobs.map((job) =>
          job.id === jobId && !isTerminalStatus(job.status)
            ? applyOutcomeToJob(job, batch, outcome, now)
            : job,
        );
        const allTerminal = jobs.every((job) => isTerminalStatus(job.status));
        const updated: JobBatchRecord = {
          ...batch,
          jobs,
          completedAt: allTerminal ? (batch.completedAt ?? now) : batch.completedAt,
        };
        yield* writeBatchFile(fs, filePath, updated);

        return {
          batchNowComplete: allTerminal && !wasAlreadyComplete,
          batch: updated,
        } satisfies CompleteJobResult;
      }),
    );
  });
}

export interface ReclaimedBatchCompletion {
  readonly agentId: string;
  readonly batch: JobBatchRecord;
}

/**
 * Reclaim jobs whose lease expired without completing (the worker holding them crashed or was
 * killed). Reclaiming consumes an attempt, same as any other failure, so a job that reliably
 * kills its worker still terminates instead of looping forever. Returns every batch that became
 * complete as a result, so the caller can fire fan-in for it exactly as `completeJob` does.
 */
export function reclaimExpiredLeases(
  baseJobBatchDirectory: string,
  now: number,
): Effect.Effect<readonly ReclaimedBatchCompletion[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const agentIds = yield* listAgentIdsWithActiveBatches(baseJobBatchDirectory);
    const fs = yield* FileSystem.FileSystem;
    const newlyCompleted: ReclaimedBatchCompletion[] = [];

    for (const agentId of agentIds) {
      const agentDir = agentDirectory(baseJobBatchDirectory, agentId);
      const names = yield* fs
        .readDirectory(agentDir)
        .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
      const batchIds = names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));

      for (const batchId of batchIds) {
        const completion = yield* withLock(
          batchLockPath(baseJobBatchDirectory, agentId, batchId),
          Effect.gen(function* () {
            const filePath = batchFilePath(baseJobBatchDirectory, agentId, batchId);
            const batch = yield* readBatchFile(fs, filePath);
            if (batch === null || batch.completedAt !== null) return null;

            const expired = batch.jobs.filter(
              (job) =>
                job.status === "running" &&
                job.leaseExpiresAt !== null &&
                job.leaseExpiresAt <= now,
            );
            if (expired.length === 0) return null;

            const jobs = batch.jobs.map((job) =>
              job.status === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now
                ? applyOutcomeToJob(
                    job,
                    batch,
                    {
                      success: false,
                      result: null,
                      error: "Job's worker lease expired before it completed.",
                    },
                    now,
                  )
                : job,
            );
            const allTerminal = jobs.every((job) => isTerminalStatus(job.status));
            const updated: JobBatchRecord = {
              ...batch,
              jobs,
              completedAt: allTerminal ? now : batch.completedAt,
            };
            yield* writeBatchFile(fs, filePath, updated);
            return allTerminal
              ? ({ agentId, batch: updated } satisfies ReclaimedBatchCompletion)
              : null;
          }),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (completion !== null) newlyCompleted.push(completion);
      }
    }

    return newlyCompleted;
  });
}
