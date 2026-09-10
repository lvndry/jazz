import { drainAgentJobs } from "@jazz/adapters/daemon/job-worker";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { Effect } from "effect";

/**
 * Internal, invoked by the detached worker `enqueue_batch` starts: drain this agent's due jobs.
 *
 * Agent-scoped rather than batch-scoped so two batches enqueued seconds apart do not start two
 * workers racing for the same lease — the first drains both, the second finds nothing and exits.
 */
export function runJobsCommand(options: { agent: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info("Draining background jobs", { agentId: options.agent });
    yield* drainAgentJobs(options.agent);
  });
}
