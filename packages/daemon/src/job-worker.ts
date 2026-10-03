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
import {
  archiveBatch,
  archiveCompletedBatches,
  claimBatchFanIn,
  claimDueJobs,
  completeJob,
  jobClaimKey,
  listAgentIdsWithActiveBatches,
  listUndeliveredBatches,
  nextClaimableAt,
  reclaimExpiredLeases,
  recordJobProgress,
  renewJobLease,
  settleBatchFanIn,
  type ClaimedJob,
} from "@jazz/adapters/job-queue-service";
import { inFlight } from "@jazz/adapters/runs/runs-in-flight";
import { tailForModel } from "@jazz/core/agent/tools/capped-output";
import { pollUntilSuccess, type PollUntilOutcome } from "@jazz/core/agent/tools/poll-until";
import { runShellCommand } from "@jazz/core/agent/tools/shell";
import { toolKnownSecrets } from "@jazz/core/agent/tools/tool-secrets";
import {
  COMPLETED_BATCH_SWEEP_INTERVAL_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  WAIT_RECENT_CHECKS_KEPT,
  WORKER_POOL_SIZE,
} from "@jazz/core/constants/job-queue";
import type { JobBatchRecord, JobCheck, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { redactSecretText, type KnownSecret } from "@jazz/core/secrets/redaction";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { createSanitizedEnv } from "@jazz/core/utils/env";
import { toError } from "@jazz/core/utils/errors";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Cause, Duration, Effect, Exit, Schedule } from "effect";
import { runUnattendedTurn } from "@/daemon/unattended-resume";

function jobBatchDirectory(): string {
  return `${getJazzHomeDirectory()}/job-batches`;
}

function formatWaitLine(job: JobRecord, tail: (output: string) => string): string {
  const output = (job.result?.stdout?.trim() || job.result?.stderr?.trim()) ?? "";
  const lastOutput = output ? `\n\`\`\`\n${tail(output)}\n\`\`\`` : "";
  if (job.status === "succeeded") {
    return `- Wait for \`${job.command}\`: the condition holds now.${lastOutput}`;
  }
  return `- Wait for \`${job.command}\`: gave up, the condition never held (${job.lastError ?? "timed out"}). Last check:${lastOutput || " no output."}`;
}

function formatJobLine(job: JobRecord, known: readonly KnownSecret[]): string {
  const tail = (output: string): string => tailForModel(redactSecretText(output, known));
  if (job.status === "cancelled") {
    return `- \`${job.command}\`: cancelled before it ran.`;
  }
  if (job.poll !== undefined) {
    return formatWaitLine(job, tail);
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

/**
 * Exported for test: the entire report a woken agent gets about its batch, with every job's
 * output redacted against `known` and by shape before it is trimmed.
 */
export function summarizeBatch(batch: JobBatchRecord, known: readonly KnownSecret[]): string {
  const succeeded = batch.jobs.filter((job) => job.status === "succeeded").length;
  const lines = batch.jobs.map((job) => formatJobLine(job, known));
  return (
    `Background job batch "${batch.reason}" finished: ${succeeded}/${batch.jobs.length} succeeded.\n\n` +
    `${lines.join("\n")}\n\n` +
    "Continue with whatever this batch was for."
  );
}

/**
 * Deliver a completed batch's fan-in at least once: claim it, resume the owning conversation
 * with the results, then stamp `deliveredAt`, or keep the error for a retry when the turn
 * failed. A batch already delivered, or being delivered by another live process, is skipped.
 */
export function deliverBatchFanIn(agentId: string, batchId: string) {
  return Effect.gen(function* () {
    const baseDirectory = jobBatchDirectory();
    const batch = yield* claimBatchFanIn(baseDirectory, agentId, batchId);
    if (batch === null) {
      return;
    }
    const known = yield* toolKnownSecrets();
    const exit = yield* runUnattendedTurn({
      agentId,
      conversationId: batch.conversationId,
      prompt: summarizeBatch(batch, known),
      fallbackTitle: batch.reason,
      source: "job batch",
      sourceId: batch.id,
    }).pipe(Effect.exit);
    const outcome: DeliveryOutcome = Exit.isSuccess(exit)
      ? exit.value
      : { delivered: false, error: Cause.pretty(exit.cause), retryable: true };
    yield* settleBatchFanIn(baseDirectory, agentId, batchId, outcome);
    if (outcome.delivered) {
      yield* archiveBatch(baseDirectory, agentId, batchId).pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

let nextCompletedBatchSweepAtMs = 0;

/** How often a running job renews its lease. */
const JOB_LEASE_HEARTBEAT_MS = 60_000;

/** Attempts at recording a job's outcome before giving up on this worker's copy of it. */
const COMPLETE_JOB_ATTEMPTS = 5;

/** First wait between those attempts; each later one doubles. */
const COMPLETE_JOB_RETRY_MS = 1_000;

/**
 * Renew the job's lease every {@link JOB_LEASE_HEARTBEAT_MS} until interrupted. The interval is
 * measured on this process's own clock (a fiber sleep), so it keeps its pace across a jump in
 * wall-clock time.
 */
function heartbeat(claimed: ClaimedJob, leaseOwner: string) {
  return Effect.sleep(Duration.millis(JOB_LEASE_HEARTBEAT_MS)).pipe(
    Effect.zipRight(
      renewJobLease(
        jobBatchDirectory(),
        claimed.agentId,
        claimed.batchId,
        claimed.jobId,
        leaseOwner,
      ).pipe(Effect.catchAll(() => Effect.succeed(true))),
    ),
    Effect.repeat({ while: (stillOurs) => stillOurs }),
    Effect.asVoid,
  );
}

/**
 * Fastest a polling job saves its progress. A check can run every 250ms, but a viewer reads the
 * record every few seconds, so writing each one would only churn the batch file's lock.
 */
const PROGRESS_RECORD_MIN_INTERVAL_MS = 2_000;

/** Longest check-output line kept on the record. */
const PROGRESS_OUTPUT_MAX_LENGTH = 200;

/** Redacted, last non-empty line of a check's output, cut to a row's worth. */
function progressOutputLine(stdout: string, stderr: string, known: readonly KnownSecret[]): string {
  const lines = redactSecretText(stdout.trim() || stderr.trim(), known)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1] ?? "";
  return line.length > PROGRESS_OUTPUT_MAX_LENGTH
    ? `${line.slice(0, PROGRESS_OUTPUT_MAX_LENGTH - 1)}…`
    : line;
}

/** Exported for test: why a watched condition never held, as the woken agent reads it. */
export function pollTimeoutMessage(polled: PollUntilOutcome): string {
  const base = `timed out after ${Math.round(polled.elapsedMs / 1000)}s and ${polled.attempts} checks`;
  if (!polled.unchanged) {
    return base;
  }
  return (
    `${base}. Every check exited ${polled.exitCode} with identical output, so the check itself ` +
    "may be unable to pass: run it once yourself and confirm it can exit 0 before waiting again"
  );
}

function runJobCommand(claimed: ClaimedJob, leaseOwner: string) {
  const env = createSanitizedEnv({}, []);
  const poll = claimed.poll;
  if (poll !== undefined) {
    return Effect.gen(function* () {
      const known = yield* toolKnownSecrets();
      let lastRecordedAt = 0;
      let recentChecks: readonly JobCheck[] = [];
      return yield* pollUntilSuccess({
        command: claimed.command,
        workingDir: claimed.workingDir,
        intervalMs: poll.intervalMs,
        timeoutMs: poll.timeoutMs,
        env,
        onCheck: (check) => {
          const now = Date.now();
          const output = progressOutputLine(check.stdout, check.stderr, known);
          recentChecks = [
            ...recentChecks,
            { check: check.attempts, at: now, exitCode: check.exitCode, output },
          ].slice(-WAIT_RECENT_CHECKS_KEPT);
          if (now - lastRecordedAt < PROGRESS_RECORD_MIN_INTERVAL_MS) {
            return Effect.void;
          }
          lastRecordedAt = now;
          return recordJobProgress(
            jobBatchDirectory(),
            claimed.agentId,
            claimed.batchId,
            claimed.jobId,
            leaseOwner,
            {
              checks: check.attempts,
              lastExitCode: check.exitCode,
              lastCheckedAt: now,
              lastOutput: output,
              recentChecks,
            },
          ).pipe(Effect.ignore);
        },
      });
    }).pipe(
      Effect.map((polled) => ({
        success: polled.matched,
        result: { stdout: polled.stdout, stderr: polled.stderr, exitCode: polled.exitCode },
        error: polled.matched ? null : pollTimeoutMessage(polled),
      })),
    );
  }
  return runShellCommand({
    command: claimed.command,
    workingDir: claimed.workingDir,
    timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
    env,
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
        error: toError(error).message,
      }),
    }),
  );
}

function runClaimedJob(claimed: ClaimedJob, leaseOwner: string) {
  return Effect.gen(function* () {
    const outcome = yield* runJobCommand(claimed, leaseOwner).pipe(
      Effect.raceFirst(heartbeat(claimed, leaseOwner).pipe(Effect.zipRight(Effect.never))),
    );

    // Recording the outcome retries on its own: a lock held for a moment by a sibling job must
    // not throw away a result that has already happened.
    const { batchNowComplete } = yield* completeJob(
      jobBatchDirectory(),
      claimed.agentId,
      claimed.batchId,
      claimed.jobId,
      outcome,
    ).pipe(
      Effect.retry(
        Schedule.exponential(Duration.millis(COMPLETE_JOB_RETRY_MS)).pipe(
          Schedule.intersect(Schedule.recurs(COMPLETE_JOB_ATTEMPTS - 1)),
        ),
      ),
    );
    if (batchNowComplete) {
      yield* deliverBatchFanIn(claimed.agentId, claimed.batchId);
    }
  }).pipe(inFlightJob(claimed));
}

function inFlightJob(claimed: ClaimedJob) {
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    inFlight(jobClaimKey(claimed.batchId, claimed.jobId), work);
}

/**
 * Run claimed jobs side by side. Each one's failure is reported on its own and never interrupts
 * its siblings: an unrecorded outcome leaves that job for lease reclaim, not the others.
 */
function runClaimedJobs(claimed: readonly ClaimedJob[], leaseOwner: string) {
  return Effect.forEach(
    claimed,
    (job) =>
      runClaimedJob(job, leaseOwner).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `jazz job ${job.batchId}/${job.jobId} could not be recorded: ${Cause.pretty(cause)}\n`,
            );
          }),
        ),
      ),
    { concurrency: WORKER_POOL_SIZE, discard: true },
  );
}
/**
 * Run one agent's background jobs to completion in this process — what makes a batch independent
 * of `jazz daemon`.
 *
 * Sleeps through a retry backoff rather than returning: a pending `nextAttemptAt` in the future
 * means the batch is unfinished, and nobody else is scheduled to come back for it.
 */
export function drainAgentJobs(agentId: string) {
  return Effect.gen(function* () {
    const baseDirectory = jobBatchDirectory();
    const leaseOwner = `${os.hostname()}-${process.pid}`;

    while (true) {
      const claimed = yield* claimDueJobs(
        baseDirectory,
        agentId,
        Date.now(),
        WORKER_POOL_SIZE,
        leaseOwner,
      ).pipe(Effect.catchAll(() => Effect.succeed<readonly ClaimedJob[]>([])));

      if (claimed.length > 0) {
        yield* runClaimedJobs(claimed, leaseOwner);
        continue;
      }

      const nextAt = yield* nextClaimableAt(baseDirectory, agentId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (nextAt === null) return;

      const waitMs = nextAt - Date.now();
      if (waitMs <= 0) {
        // Claimable by the clock but not claimed — another worker holds it. Nothing to do here.
        return;
      }
      yield* Effect.sleep(Duration.millis(Math.min(waitMs, DEFAULT_BACKOFF_MAX_MS)));
    }
  });
}

/**
 * One pass: reclaim jobs whose worker is gone, deliver every completed batch's fan-in that is
 * still owed (including retries and ones a crash interrupted), then claim and run whatever is
 * due for every agent.
 */
export function runDueJobs() {
  return Effect.gen(function* () {
    const baseDirectory = jobBatchDirectory();
    const leaseOwner = `${os.hostname()}-${process.pid}`;

    const sweepStartedAt = Date.now();
    if (sweepStartedAt >= nextCompletedBatchSweepAtMs) {
      nextCompletedBatchSweepAtMs = sweepStartedAt + COMPLETED_BATCH_SWEEP_INTERVAL_MS;
      yield* archiveCompletedBatches(baseDirectory, sweepStartedAt).pipe(
        Effect.catchAll(() => Effect.succeed(0)),
      );
    }

    yield* reclaimExpiredLeases(baseDirectory, Date.now()).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    const undelivered = yield* listUndeliveredBatches(baseDirectory).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    for (const { agentId, batchId } of undelivered) {
      yield* deliverBatchFanIn(agentId, batchId).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            process.stderr.write(
              `jazz job batch ${batchId} fan-in failed: ${Cause.pretty(cause)}\n`,
            );
          }),
        ),
      );
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
      yield* runClaimedJobs(claimed, leaseOwner);
    }
  });
}
