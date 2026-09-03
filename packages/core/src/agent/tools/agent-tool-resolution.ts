/**
 * @fileoverview What a specific configured agent actually resolves its tool set to.
 *
 * Mirrors `initializeAgentRun`'s own category/deny resolution (`agent-runner.ts`) — the same
 * logic `/tools` already duplicated once to answer "what can this agent do" without running
 * a turn (`packages/cli/src/chat/commands/handler.ts`). A second caller needing the same
 * answer (an A2A capability card advertising a peer's actual reach) is the second time this
 * exact duplication showed up, which is the point past which it becomes a shared function
 * instead of a third copy.
 *
 * Not a statement that persona carries capability — it doesn't. Persona is a mindset: a
 * system prompt, nothing about what an agent can touch. Capability is fixed by which agent
 * an operator chooses to run (its own tool config), the same for every peer who reaches it.
 * `PersonaToolProfile` exists as a field on `Persona` and, mechanically, `agent-runner.ts`
 * still applies it if one is ever set — so this function stays accurate to whatever the
 * agent's *current* persona actually resolves to, purely so nothing here can advertise more
 * than a real run would honor. It is not an endorsement of scoping capability through
 * persona; an operator wanting a narrower peer-facing identity should build a dedicated
 * agent with its own tool config, not lean on a persona's `toolProfile`.
 *
 * Deliberately partial: this resolves built-in categories and `deny`, not MCP tools, custom
 * per-agent registrations, or run-scoped exclusions like `disablePersistence`/
 * `withholdInteractiveTools`. Those depend on state only a live run has.
 */

import { Effect, Option } from "effect";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import { PersonaServiceTag } from "@/core/interfaces/persona-service";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import { BUILTIN_TOOL_CATEGORIES } from "./tool-categories";

/**
 * Remove every tool the persona or the agent denies.
 *
 * Shared by the run path and the A2A card because they resolve tool sets separately, and a
 * card advertising a tool the run withholds is worse than no card at all. Subtraction lives
 * here, in one function, so the two cannot drift.
 *
 * Applied after everything that *adds* — `config.tools` and the built-in bundle — since both
 * deny lists are meant to be final: nothing downstream should be able to put a denied tool
 * back. The two lists differ only in reach: a persona's applies to every agent sharing it,
 * an agent's to that agent alone.
 */
export function withoutDeniedTools(
  names: readonly string[],
  personaDeny: readonly string[] | undefined,
  agentDenied: readonly string[] | undefined,
): readonly string[] {
  const denied = new Set([...(personaDeny ?? []), ...(agentDenied ?? [])]);
  return denied.size === 0 ? names : names.filter((name) => !denied.has(name));
}

export function resolveAgentToolNames(
  agent: Agent,
): Effect.Effect<readonly string[], never, ToolRegistry> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;
    const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });

    // Optional on purpose, same as `/tools`: a caller that never wired PersonaService gets
    // the unrestricted default rather than a hard failure — persona narrowing is a
    // refinement on top of an agent's own tools, not a precondition for answering at all.
    const personaServiceOption = yield* Effect.serviceOption(PersonaServiceTag);
    const resolvedPersona = Option.isSome(personaServiceOption)
      ? yield* personaServiceOption.value
          .getPersonaByIdentifier(agent.config.persona)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null;
    const toolProfile = resolvedPersona?.toolProfile;

    const requestedBuiltinCategoryIds: readonly string[] =
      toolProfile?.categories !== undefined
        ? toolProfile.categories
        : agent.config.persona === "summarizer"
          ? []
          : BUILTIN_TOOL_CATEGORIES.map((category) => category.id);

    const validBuiltinCategoryIds = new Set(BUILTIN_TOOL_CATEGORIES.map((category) => category.id));
    const builtInToolNames = (yield* Effect.all(
      requestedBuiltinCategoryIds
        .filter((id) => validBuiltinCategoryIds.has(id))
        .map((id) => toolRegistry.getToolsInCategory(id)),
    )).flat();

    const combinedToolNames = [...new Set([...agentToolNames, ...builtInToolNames])];
    return withoutDeniedTools(combinedToolNames, toolProfile?.deny, agent.config.deniedTools);
  });
}
