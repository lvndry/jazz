/**
 * @fileoverview Executing background job batches on a plain interval, from inside `jazz daemon`
 * — the worker half of the job queue described in
 * docs/superpowers/plans/job-queue-design.md. Ticked from `trigger-runner.ts` alongside wake
 * triggers and workflow catch-up.
 *
 * A batch's completion (fan-in) reuses the exact resume mechanism wake triggers already use —
 * `runUnattendedTurn` against the batch's `conversationId` — the only difference is what causes
 * the resume: a job finishing rather than a clock firing.
 */

import * as os from "node:os";
import { runShellCommand } from "@jazz/core/agent/tools/shell-tools";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  JOB_OUTPUT_TAIL_CHARS,
  WORKER_POOL_SIZE,
} from "@jazz/core/constants/job-queue";
import type { JobBatchRecord, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { createSanitizedEnv } from "@jazz/core/utils/env";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { runUnattendedTurn } from "@/adapters/daemon/unattended-resume";
import {
  claimDueJobs,
  completeJob,
  listAgentIdsWithActiveBatches,
  reclaimExpiredLeases,
  type ClaimedJob,
} from "@/adapters/job-queue-service";

function jobBatchDirectory(): string {
  return `${getJazzHomeDirectory()}/job-batches`;
}

function tail(output: string): string {
  if (output.length <= JOB_OUTPUT_TAIL_CHARS) return output;
  return `…(earlier output trimmed)…\n${output.slice(-JOB_OUTPUT_TAIL_CHARS)}`;
}

/** Quotes what a job printed: an exit code alone tells a polling agent nothing it can act on. */
function formatJobLine(job: JobRecord): string {
  if (job.status === "cancelled") {
    return `- \`${job.command}\`: cancelled before it ran.`;
  }
  if (job.status === "succeeded") {
    const attempts = job.attempt > 1 ? ` (attempt ${job.attempt})` : "";
    const stdout = job.result?.stdout?.trim();
    return stdout
      ? `- \`${job.command}\`: succeeded${attempts}, and printed:\n\`\`\`\n${tail(stdout)}\n\`\`\``
      : `- \`${job.command}\`: succeeded${attempts} with no output.`;
  }
  const diagnostics = job.result?.stderr?.trim() || job.result?.stdout?.trim();
  const why = diagnostics
    ? `\n\`\`\`\n${tail(diagnostics)}\n\`\`\``
    : ` — ${job.lastError ?? "no output captured"}`;
  return `- \`${job.command}\`: failed after ${job.attempt} attempt(s)${why}`;
}

/** Exported for test: this string is the entire report a woken agent gets about its batch. */
export function summarizeBatch(batch: JobBatchRecord): string {
  const succeeded = batch.jobs.filter((job) => job.status === "succeeded").length;
  const lines = batch.jobs.map(formatJobLine);
  return (
    `Background job batch "${batch.reason}" finished: ${succeeded}/${batch.jobs.length} succeeded.\n\n` +
    `${lines.join("\n")}\n\n` +
    "Continue with whatever this batch was for."
  );
}

/** A finished batch is one more reason to fire an unattended turn; the rest is shared. */
function fireBatchResume(agentId: string, batch: JobBatchRecord) {
  return runUnattendedTurn({
    agentId,
    conversationId: batch.conversationId,
    prompt: summarizeBatch(batch),
    fallbackTitle: batch.reason,
    source: "job batch",
    sourceId: batch.id,
  });
}

function runClaimedJob(claimed: ClaimedJob) {
  return Effect.gen(function* () {
    const outcome = yield* runShellCommand({
      command: claimed.command,
      workingDir: claimed.workingDir,
      timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
      env: createSanitizedEnv({}, []),
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({
          success: result.exitCode === 0,
          result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
          error: result.exitCode === 0 ? null : `exit code ${result.exitCode}`,
        }),
        onFailure: (error) => ({
          success: false,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      }),
    );

    const { batchNowComplete, batch } = yield* completeJob(
      jobBatchDirectory(),
      claimed.agentId,
      claimed.batchId,
      claimed.jobId,
      outcome,
    );
    if (batchNowComplete && batch !== null) {
      yield* fireBatchResume(claimed.agentId, batch);
    }
  });
}

/** One tick: reclaim abandoned jobs, then claim and run whatever is due for every agent. */
export function runDueJobs() {
  return Effect.gen(function* () {
    const baseDirectory = jobBatchDirectory();
    const leaseOwner = `${os.hostname()}-${process.pid}`;

    const reclaimed = yield* reclaimExpiredLeases(baseDirectory, Date.now()).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    for (const { agentId, batch } of reclaimed) {
      yield* fireBatchResume(agentId, batch);
    }

    const agentIds = yield* listAgentIdsWithActiveBatches(baseDirectory).pipe(
      Effect.catchAll(() => Effect.succeed<readonly string[]>([])),
    );
    for (const agentId of agentIds) {
      const claimed = yield* claimDueJobs(
        baseDirectory,
        agentId,
        Date.now(),
        WORKER_POOL_SIZE,
        leaseOwner,
      ).pipe(Effect.catchAll(() => Effect.succeed<readonly ClaimedJob[]>([])));
      yield* Effect.forEach(claimed, runClaimedJob, { concurrency: WORKER_POOL_SIZE }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  });
}
