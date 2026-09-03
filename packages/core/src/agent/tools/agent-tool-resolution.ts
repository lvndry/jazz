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
import type { PersonaToolProfile } from "@/core/types/persona";
import { BUILTIN_TOOL_CATEGORIES } from "./tool-categories";

/**
 * Every tool withheld from this agent, from either scope that can withhold one.
 *
 * The set, not a filter over it. What the run path and the A2A card have to agree on is
 * *where denials come from* — a caller that forgets `deniedTools` exists is the failure that
 * matters, and one that writes `.filter` wrong is not a failure anyone has ever had. Adding
 * a third source later fixes both callers at once; the subtraction itself stays visible at
 * each call site rather than hidden behind a name.
 *
 * The two scopes differ only in reach: a persona's `deny` applies to every agent sharing
 * that persona, an agent's `deniedTools` to that agent alone. Neither is meant to be
 * undoable, so callers subtract this last — after `config.tools` and the built-in bundle,
 * both of which only ever add.
 */
export function toolDenials(
  agent: Agent,
  toolProfile: PersonaToolProfile | undefined,
): ReadonlySet<string> {
  return new Set([...(toolProfile?.deny ?? []), ...(agent.config.deniedTools ?? [])]);
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
    const denied = toolDenials(agent, toolProfile);
    return combinedToolNames.filter((name) => !denied.has(name));
  });
}
