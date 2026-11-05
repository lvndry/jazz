import type { AgentRunner } from "@jazz/core/agent/agent-runner";
import type { Effect } from "effect";

/**
 * Widens a stand-in for `AgentRunner.run` to the method's type. The stand-in answers with whatever
 * partial response or failure a test needs and needs no services, so its result and requirement
 * types are looser than the real method's.
 */
export function agentRunStub(
  implementation: (options: never) => Effect.Effect<unknown, unknown>,
): typeof AgentRunner.run {
  return implementation as typeof AgentRunner.run;
}
