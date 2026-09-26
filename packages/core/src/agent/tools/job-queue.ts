import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import {
  JOB_COMMAND_MAX_LENGTH,
  JOB_REASON_MAX_LENGTH,
  JOB_TIMEOUT_MINUTES,
  MAX_CONCURRENCY_CAP,
  MAX_JOBS_PER_BATCH,
  MAX_MAX_ATTEMPTS,
} from "@/core/constants/job-queue";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { JobBatchRecord, JobQueueService } from "@/core/interfaces/job-queue-service";
import { JobQueueServiceTag } from "@/core/interfaces/job-queue-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import { spawnJobWorker } from "@/core/jobs/spawn-job-worker";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineApprovalTool, defineTool, makeZodValidator } from "./base-tool";
import { tailForModel } from "./capped-output";
import { buildKeyFromContext } from "./context-utils";
import { denylistBlockedError } from "./shell";

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

function tailOutput(output: string | undefined): string | null {
  const trimmed = output?.trim();
  if (!trimmed) return null;
  return tailForModel(trimmed);
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
      stdout: tailOutput(job.result?.stdout),
      stderr: tailOutput(job.result?.stderr),
    })),
  };
}

const enqueueBatchParameters = z
  .object({
    jobs: z
      .array(
        z.object({
          command: z.string().min(1).max(JOB_COMMAND_MAX_LENGTH).describe("Shell command to run."),
        }),
      )
      .min(1)
      .max(MAX_JOBS_PER_BATCH)
      .describe("Independent commands; each becomes its own retried job."),
    concurrencyCap: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENCY_CAP)
      .optional()
      .describe(`Jobs running at once across the batch (default 3, max ${MAX_CONCURRENCY_CAP}).`),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_ATTEMPTS)
      .optional()
      .describe(`Attempts per job, with exponential backoff (default 1, max ${MAX_MAX_ATTEMPTS}).`),
    reason: z
      .string()
      .min(1)
      .max(JOB_REASON_MAX_LENGTH)
      .describe("What this batch is for; shown to the person in list_jobs."),
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
    summary:
      "Run shell commands in the background and get woken with what they printed — monitor or " +
      "watch something until it finishes, poll a log, a page, a price or a repo for changes, " +
      "run the same check across several targets. Each job is capped at " +
      `${JOB_TIMEOUT_MINUTES} minutes.`,

    description:
      "Run independent shell commands in the background while you keep working. Returns a batchId at once; you are woken with each job's status and output when every job finishes or exhausts its retries. Call list_jobs only when the user asks for progress. Put commands that depend on each other's output in one job.\n\n" +
      `Each job is killed at ${JOB_TIMEOUT_MINUTES} minutes: bound long-running commands ` +
      "(`timeout 60 tail -f app.log`).",
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

        // Start the worker here rather than leaving the batch for a daemon that may not be
        // running. Without this the tool returned a batch id, the person approved unattended
        // execution, and then nothing ran and nothing woke them.
        const worker = yield* spawnJobWorker(context.agentId);

        return {
          success: true,
          result: {
            batchId: outcome.batch.id,
            jobCount: outcome.batch.jobs.length,
            // Said out loud when it fails, because the failure is invisible otherwise: the batch
            // is enqueued either way, but without a worker it only runs if `jazz daemon` happens
            // to be running, and waiting silently for a wake-up that never comes is the worst
            // available outcome.
            ...(worker.spawned
              ? {}
              : {
                  warning:
                    `No background worker could be started (${worker.reason ?? "unknown reason"}), ` +
                    "so these jobs will only run if `jazz daemon` is running. Do not assume you " +
                    "will be woken with the results — tell the person, and consider running the " +
                    "commands directly instead.",
                }),
          },
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
        .describe("Batch id from enqueue_batch; omit for all active batches."),
    })
    .strict();

  const listJobs = defineTool<JobQueueToolDeps, z.infer<typeof listJobsParameters>>({
    name: "list_jobs",
    disclosure: "internal",
    summary:
      "Check on background jobs already started: each batch's progress, every job's status, and " +
      "the output it printed.",
    description: "List this agent's job batches with each job's status and output.",
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
      batchId: z.string().min(1).describe("Batch id from list_jobs."),
    })
    .strict();

  const cancelBatch = defineTool<JobQueueToolDeps, z.infer<typeof cancelBatchParameters>>({
    name: "cancel_batch",
    disclosure: "internal",
    summary: "Cancel a job batch's pending jobs by id (get the id from list_jobs first).",
    description: "Cancel a job batch's jobs that haven't started; running jobs finish.",
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
