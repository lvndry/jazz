/**
 * @fileoverview Executing background job batches on a plain interval, from inside `jazz daemon`
 * — the worker half of the job queue described in
 * docs/superpowers/plans/job-queue-design.md. Ticked from `trigger-runner.ts` alongside wake
 * triggers and workflow catch-up.
 *
 * A batch's completion (fan-in) reuses the exact resume mechanism wake triggers already use —
 * `AgentRunner.run` with `parkWhenUnattended: true` against the batch's `conversationId` — the
 * only difference is what causes the resume: a job finishing rather than a clock firing.
 */

import * as os from "node:os";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { runShellCommand } from "@jazz/core/agent/tools/shell-tools";
import { DEFAULT_JOB_TIMEOUT_MS, WORKER_POOL_SIZE } from "@jazz/core/constants/job-queue";
import type { JobBatchRecord, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { createSanitizedEnv } from "@jazz/core/utils/env";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import {
  claimDueJobs,
  completeJob,
  listAgentIdsWithActiveBatches,
  reclaimExpiredLeases,
  type ClaimedJob,
} from "@/adapters/job-queue-service";
import {
  loadConversation,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";

function jobBatchDirectory(): string {
  return `${getJazzHomeDirectory()}/job-batches`;
}

function formatJobLine(job: JobRecord): string {
  if (job.status === "succeeded") {
    return `- \`${job.command}\`: succeeded${job.attempt > 1 ? ` (attempt ${job.attempt})` : ""}.`;
  }
  if (job.status === "cancelled") {
    return `- \`${job.command}\`: cancelled before it ran.`;
  }
  const stderrTail = job.result?.stderr
    ? job.result.stderr.slice(-500)
    : (job.lastError ?? "no output captured");
  return `- \`${job.command}\`: failed after ${job.attempt} attempt(s) — ${stderrTail}`;
}

function summarizeBatch(batch: JobBatchRecord): string {
  const succeeded = batch.jobs.filter((job) => job.status === "succeeded").length;
  const lines = batch.jobs.map(formatJobLine);
  return (
    `Background job batch "${batch.reason}" finished: ${succeeded}/${batch.jobs.length} succeeded.\n\n` +
    `${lines.join("\n")}\n\n` +
    "Continue with whatever this batch was for."
  );
}

/**
 * Resume the batch's owning conversation with a synthesized summary of every job's outcome.
 * Mirrors `fireWakeTrigger` in `trigger-runner.ts` exactly — same load/run/save shape — because a
 * finished batch is just a different reason to fire the same kind of unattended resume.
 */
function fireBatchResume(agentId: string, batch: JobBatchRecord) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const agentResult = yield* getAgentByIdentifier(agentId).pipe(Effect.either);
    if (agentResult._tag === "Left") {
      yield* logger.warn("Job batch resume skipped: agent not found", {
        agentId,
        batchId: batch.id,
      });
      return;
    }
    const agent = agentResult.right;

    const priorRecord = yield* loadConversation(agentId, batch.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    const response = yield* AgentRunner.run({
      agent,
      userInput: summarizeBatch(batch),
      conversationId: batch.conversationId,
      parkWhenUnattended: true,
      ...(priorRecord !== null ? { conversationHistory: priorRecord.messages } : {}),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logger.warn("Job batch resume run failed", {
            agentId,
            batchId: batch.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }),
      ),
    );
    if (response === undefined) return;

    const now = new Date().toISOString();
    yield* saveConversation({
      agentId,
      conversationId: batch.conversationId,
      title: priorRecord?.title ?? batch.reason.slice(0, 80),
      startedAt: priorRecord?.startedAt ?? now,
      endedAt: now,
      messages: response.messages ?? priorRecord?.messages ?? [],
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Job batch resume conversation save failed", {
          agentId,
          batchId: batch.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
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
