import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import {
  JOB_COMMAND_MAX_LENGTH,
  JOB_REASON_MAX_LENGTH,
  MAX_CONCURRENCY_CAP,
  MAX_JOBS_PER_BATCH,
  MAX_MAX_ATTEMPTS,
} from "@/core/constants/job-queue";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { JobBatchRecord, JobQueueService } from "@/core/interfaces/job-queue-service";
import { JobQueueServiceTag } from "@/core/interfaces/job-queue-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineApprovalTool, defineTool, makeZodValidator } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";
import { denylistBlockedError } from "./shell-tools";

type JobQueueToolDeps = JobQueueService | FileSystemContextService | FileSystem.FileSystem;

function summarizeJobStatuses(batch: JobBatchRecord): {
  succeeded: number;
  failed: number;
  pending: number;
  running: number;
  cancelled: number;
} {
  const counts = { succeeded: 0, failed: 0, pending: 0, running: 0, cancelled: 0 };
  for (const job of batch.jobs) counts[job.status]++;
  return counts;
}

function formatBatchSummary(batch: JobBatchRecord) {
  const counts = summarizeJobStatuses(batch);
  return {
    batchId: batch.id,
    reason: batch.reason,
    concurrencyCap: batch.concurrencyCap,
    createdAt: new Date(batch.createdAt).toISOString(),
    completedAt: batch.completedAt !== null ? new Date(batch.completedAt).toISOString() : null,
    jobCount: batch.jobs.length,
    counts,
    jobs: batch.jobs.map((job) => ({
      id: job.id,
      command: job.command,
      status: job.status,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      exitCode: job.result?.exitCode ?? null,
      lastError: job.lastError,
    })),
  };
}

const enqueueBatchParameters = z
  .object({
    jobs: z
      .array(
        z.object({
          command: z
            .string()
            .min(1)
            .max(JOB_COMMAND_MAX_LENGTH)
            .describe("The shell command to run."),
        }),
      )
      .min(1)
      .max(MAX_JOBS_PER_BATCH)
      .describe("Independent shell commands to run — each becomes its own retried job."),
    concurrencyCap: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENCY_CAP)
      .optional()
      .describe(
        `How many jobs run at once, across the whole batch (default 3, max ${MAX_CONCURRENCY_CAP}).`,
      ),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_ATTEMPTS)
      .optional()
      .describe(
        `Attempts per job before giving up, with exponential backoff between retries (default 1, max ${MAX_MAX_ATTEMPTS}).`,
      ),
    reason: z
      .string()
      .min(1)
      .max(JOB_REASON_MAX_LENGTH)
      .describe(
        "Brief note on what this batch is for, shown via list_jobs to a human — not sent back to you.",
      ),
  })
  .strict();

type EnqueueBatchArgs = z.infer<typeof enqueueBatchParameters>;

export function createJobQueueTools(): {
  readonly enqueueBatch: ReturnType<typeof defineApprovalTool<JobQueueToolDeps, EnqueueBatchArgs>>;
  readonly listJobs: Tool<JobQueueToolDeps>;
  readonly cancelBatch: Tool<JobQueueToolDeps>;
} {
  const enqueueBatch = defineApprovalTool<JobQueueToolDeps, EnqueueBatchArgs>({
    name: "enqueue_batch",
    disclosure: "private",
    description:
      "Run several independent shell commands in the background, with a concurrency cap and " +
      "per-job retry/backoff, without blocking your turn. Returns immediately with a batchId — " +
      "you will be woken up with a summary once every job in the batch reaches a final state " +
      "(succeeded or exhausted its retries). Do not poll in a loop; call list_jobs only if the " +
      "user explicitly asks for a progress check. Use this instead of chaining execute_command " +
      "calls with sleeps when the work is independent (e.g. running the same check across " +
      "several repos, retrying a flaky command) — not for commands that depend on each other's " +
      "output.",
    parameters: enqueueBatchParameters,
    riskLevel: "unknown",
    validate: makeZodValidator(enqueueBatchParameters),
    approvalMessage: (args) => {
      for (const job of args.jobs) {
        const blocked = denylistBlockedError(job.command);
        if (blocked) {
          return Effect.succeed({
            skipApproval: true as const,
            toolResult: { success: false, result: null, error: blocked } as const,
          });
        }
      }

      const commandList = args.jobs.map((job, index) => `${index + 1}. ${job.command}`).join("\n");
      return Effect.succeed(`Background job batch: ${args.reason}

${commandList}

Concurrency cap: ${args.concurrencyCap ?? 3}
Max attempts per job: ${args.maxAttempts ?? 1}

These commands will run unattended, without further approval, until every job finishes. Only approve commands you trust.`);
    },
    approvalErrorMessage:
      "Running a background job batch requires explicit user approval for security reasons.",
    handler: (args, context) =>
      Effect.gen(function* () {
        if (context.conversationId === undefined) {
          return {
            success: false,
            result: null,
            error: "No conversation to resume — enqueue_batch is unavailable in this context.",
          } satisfies ToolExecutionResult;
        }

        const jobQueueService = yield* JobQueueServiceTag;
        const shell = yield* FileSystemContextServiceTag;
        const workingDir = yield* shell.getCwd(buildKeyFromContext(context));

        const outcome = yield* jobQueueService.enqueueBatch(
          context.agentId,
          context.conversationId,
          args.jobs,
          {
            workingDir,
            reason: args.reason,
            ...(args.concurrencyCap !== undefined ? { concurrencyCap: args.concurrencyCap } : {}),
            ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
          },
        );

        if (!outcome.success) {
          return {
            success: false,
            result: null,
            error: outcome.message,
          } satisfies ToolExecutionResult;
        }

        return {
          success: true,
          result: { batchId: outcome.batch.id, jobCount: outcome.batch.jobs.length },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { batchId: string; jobCount: number };
      return `Enqueued batch ${data.batchId} (${data.jobCount} jobs)`;
    },
  });

  const listJobsParameters = z
    .object({
      batchId: z
        .string()
        .min(1)
        .optional()
        .describe("A specific batch id, from enqueue_batch. Omit to list all active batches."),
    })
    .strict();

  const listJobs = defineTool<JobQueueToolDeps, z.infer<typeof listJobsParameters>>({
    name: "list_jobs",
    disclosure: "internal",
    description:
      "List this agent's background job batches (active, or a specific one by id) and every job's status.",
    parameters: listJobsParameters,
    riskLevel: "read-only",
    validate: makeZodValidator(listJobsParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const jobQueueService = yield* JobQueueServiceTag;

        if (args.batchId !== undefined) {
          const batch = yield* jobQueueService.getBatch(context.agentId, args.batchId);
          if (batch === null) {
            return {
              success: false,
              result: null,
              error: `No job batch found with id "${args.batchId}".`,
            } satisfies ToolExecutionResult;
          }
          return {
            success: true,
            result: { batches: [formatBatchSummary(batch)] },
          } satisfies ToolExecutionResult;
        }

        const batches = yield* jobQueueService.listActiveBatches(context.agentId);
        return {
          success: true,
          result: { batches: batches.map(formatBatchSummary) },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { batches: readonly unknown[] };
      return `Listed job batches (${data.batches.length})`;
    },
  });

  const cancelBatchParameters = z
    .object({
      batchId: z.string().min(1).describe("The id of the job batch to cancel, from list_jobs."),
    })
    .strict();

  const cancelBatch = defineTool<JobQueueToolDeps, z.infer<typeof cancelBatchParameters>>({
    name: "cancel_batch",
    disclosure: "internal",
    description:
      "Cancel a job batch's pending jobs by id (get the id from list_jobs first). Jobs already " +
      "running finish naturally — this only stops jobs that haven't started yet.",
    parameters: cancelBatchParameters,
    riskLevel: "low-risk",
    validate: makeZodValidator(cancelBatchParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const jobQueueService = yield* JobQueueServiceTag;
        const outcome = yield* jobQueueService.cancelBatch(context.agentId, args.batchId);
        return {
          success: outcome.success,
          result: outcome.success ? { message: outcome.message } : null,
          ...(outcome.success ? {} : { error: outcome.message }),
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { message: string };
      return data.message;
    },
  });

  return { enqueueBatch, listJobs, cancelBatch };
}
