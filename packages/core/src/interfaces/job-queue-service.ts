import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";
import { z } from "zod";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  readonly id: string;
  readonly command: string;
  readonly status: JobStatus;
  /** 1-based; incremented each time a failed job is retried. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Epoch ms; a job is claimable once this has passed. */
  readonly nextAttemptAt: number;
  /** Opaque id of the worker currently holding this job's claim, or null when unclaimed. */
  readonly leaseOwner: string | null;
  /** Epoch ms after which an unfinished claim is considered abandoned and reclaimable. */
  readonly leaseExpiresAt: number | null;
  readonly result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  } | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JobBackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
}

export interface JobBatchRecord {
  readonly id: string;
  readonly agentId: string;
  readonly conversationId: string;
  /** Working directory every job in the batch runs in — the agent's cwd at enqueue time. */
  readonly workingDir: string;
  readonly concurrencyCap: number;
  readonly backoff: JobBackoffPolicy;
  /** Why the agent enqueued this batch, shown via list_jobs — not sent to the model. */
  readonly reason: string;
  readonly createdAt: number;
  /** Epoch ms once every job is terminal (succeeded, failed, or cancelled); null while active. */
  readonly completedAt: number | null;
  readonly jobs: readonly JobRecord[];
}

const JobRecordSchema: z.ZodType<JobRecord> = z.object({
  id: z.string().min(1),
  command: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.number().finite(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.number().finite().nullable(),
  result: z
    .object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() })
    .nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

/** On-disk shape of one {@link JobBatchRecord}, checked on every read. */
export const JobBatchRecordSchema: z.ZodType<JobBatchRecord> = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  workingDir: z.string(),
  concurrencyCap: z.number().int().positive(),
  backoff: z.object({ initialMs: z.number().nonnegative(), maxMs: z.number().nonnegative() }),
  reason: z.string(),
  createdAt: z.number().finite(),
  completedAt: z.number().finite().nullable(),
  jobs: z.array(JobRecordSchema),
});

export interface EnqueueBatchJobInput {
  readonly command: string;
}

export interface EnqueueBatchOptions {
  readonly workingDir: string;
  readonly concurrencyCap?: number;
  readonly maxAttempts?: number;
  readonly reason: string;
}

export type EnqueueBatchOutcome =
  | { readonly success: true; readonly batch: JobBatchRecord }
  | { readonly success: false; readonly message: string };

export type CancelBatchOutcome = { readonly success: boolean; readonly message: string };

/**
 * Fan-out/fan-in background job batches: the agent enqueues N independent shell commands with a
 * concurrency cap and per-job retry/backoff, the daemon's worker executes them unattended, and
 * fan-in (every job reaching a terminal state) fires a wake-style resume of the owning
 * conversation — the same "come back later" mechanism {@link WakeTriggerService} uses, just
 * triggered by job completion instead of a clock. See docs/superpowers/plans/job-queue-design.md.
 */
export interface JobQueueService {
  readonly enqueueBatch: (
    agentId: string,
    conversationId: string,
    jobs: readonly EnqueueBatchJobInput[],
    options: EnqueueBatchOptions,
  ) => Effect.Effect<EnqueueBatchOutcome, Error, FileSystem.FileSystem>;

  readonly getBatch: (
    agentId: string,
    batchId: string,
  ) => Effect.Effect<JobBatchRecord | null, Error, FileSystem.FileSystem>;

  readonly listActiveBatches: (
    agentId: string,
  ) => Effect.Effect<readonly JobBatchRecord[], Error, FileSystem.FileSystem>;

  readonly cancelBatch: (
    agentId: string,
    batchId: string,
  ) => Effect.Effect<CancelBatchOutcome, Error, FileSystem.FileSystem>;
}

export const JobQueueServiceTag = Context.GenericTag<JobQueueService>("JobQueueService");
