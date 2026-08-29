import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

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
