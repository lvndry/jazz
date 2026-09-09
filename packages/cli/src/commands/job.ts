import { drainAgentJobs } from "@jazz/adapters/daemon/job-worker";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { Effect } from "effect";

/**
 * Internal command invoked by the detached worker process `enqueue_batch` starts, not meant for
 * interactive use: run this agent's due background jobs until none are left, then exit.
 *
 * Scoped to an agent rather than a batch id even though one batch is what triggered it. Two
 * batches enqueued seconds apart would otherwise start two workers racing for the same lease, and
 * the claim path is already per-agent — so whichever worker gets there first drains both, and the
 * second finds nothing to claim and exits.
 */
export function runJobsCommand(options: { agent: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info("Draining background jobs", { agentId: options.agent });
    yield* drainAgentJobs(options.agent);
  });
}
