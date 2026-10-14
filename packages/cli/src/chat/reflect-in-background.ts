/**
 * Start the end-of-conversation lesson pass in a detached `jazz memory reflect`, so closing or
 * leaving a conversation never waits on a model call and the pass outlives the chat process.
 */

import { spawnDetachedJazz } from "@jazz/core/jobs/spawn-job-worker";
import { Effect } from "effect";

export function reflectInBackground(agentId: string, conversationId: string): Effect.Effect<void> {
  return spawnDetachedJazz([
    "--output",
    "quiet",
    "memory",
    "reflect",
    "--agent",
    agentId,
    "--conversation",
    conversationId,
  ]).pipe(Effect.asVoid);
}
