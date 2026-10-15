/**
 * Start the end-of-conversation lesson pass in a detached `jazz memory reflect`, so closing or
 * leaving a conversation never waits on a model call and the pass outlives the chat process.
 */

import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { spawnDetachedJazz } from "@jazz/core/jobs/spawn-job-worker";
import { Effect } from "effect";

/**
 * A launch failure is logged rather than shown: the chat is closing or switching, and the
 * messages it would have reflected on stay unclaimed, so the next close covers them.
 */
export function reflectInBackground(agentId: string, conversationId: string, configPath?: string) {
  return Effect.gen(function* () {
    const launch = yield* spawnDetachedJazz([
      ...(configPath === undefined ? [] : ["--config", configPath]),
      "--output",
      "quiet",
      "memory",
      "reflect",
      "--agent",
      agentId,
      "--conversation",
      conversationId,
    ]);
    if (!launch.spawned) {
      const logger = yield* LoggerServiceTag;
      yield* logger.warn("Could not start the end-of-conversation lesson pass", {
        agentId,
        conversationId,
        reason: launch.reason,
      });
    }
  });
}
