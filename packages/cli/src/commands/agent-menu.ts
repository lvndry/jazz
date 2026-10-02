/**
 * The shared agent list and per-agent action menu: the same screens the `/agents`
 * command and the Settings wizard's Agents entry open, so both reach the same
 * details view and the same `editAgentCommand` wizard (tools, model, persona,
 * name) rather than each building its own.
 */
import { loadHistory } from "@jazz/adapters/history/conversation-history-service";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { isLocalServerProvider, isZeroCostLocalModel } from "@jazz/core/constants/local-providers";
import { isOllamaCloudModel } from "@jazz/core/constants/ollama";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/index";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { agentModelString } from "@jazz/core/utils/provider-model";
import { Effect } from "effect";
import { agentDetailFields } from "./agent-details";
import { deleteAgentCommand } from "./agent-management";
import { store, type ActiveAgentChoice } from "../ui/store";

type AgentAction = "start" | "details" | "edit" | "delete" | "back";

export function agentChoicesFor(
  agents: readonly Agent[],
  lastUsedAgentId: string | null | undefined,
): readonly ActiveAgentChoice[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    model: agentModelString(agent.config.llm),
    persona: agent.config.persona,
    ...(agent.description !== undefined && agent.description !== agent.name
      ? { description: agent.description }
      : {}),
    ...(agent.id === lastUsedAgentId ? { lastUsed: true as const } : {}),
  }));
}

/**
 * Show the agent list. `previouslyOpenedId` returns the reader to the agent that
 * was open before the actions menu, so leaving details or edit comes back in place.
 */
export function showAgentList(
  agents: readonly Agent[],
  lastUsedAgentId: string | null | undefined,
  previouslyOpenedId?: string,
): Effect.Effect<Agent | null, never, never> {
  return Effect.async<Agent | null>((resume) => {
    const sorted = sortAgents(agents, lastUsedAgentId);
    store.setActiveMenu(
      {
        kind: "agents",
        title: "agents",
        action: "details",
        agents: agentChoicesFor(sorted, lastUsedAgentId),
        ...(previouslyOpenedId === undefined
          ? {}
          : {
              initialIndex: Math.max(
                0,
                sorted.findIndex((agent) => agent.id === previouslyOpenedId),
              ),
            }),
      },
      (result) => {
        resume(
          Effect.succeed(
            result.kind === "exit"
              ? null
              : (agents.find((agent) => agent.id === result.value) ?? null),
          ),
        );
      },
    );
  });
}

/** Display one selected agent until the reader returns to the list. */
export function showAgentDetails(
  agent: Agent,
  metadata: Awaited<ReturnType<typeof getModelsDevMetadata>>,
  hostUrl: string | undefined,
): Effect.Effect<void, never, never> {
  return Effect.async<void>((resume) => {
    store.setActiveMenu(
      {
        kind: "agent-details",
        name: agent.name,
        fields: agentDetailFields(agent, metadata, hostUrl),
      },
      () => resume(Effect.void),
    );
  });
}

/** What to do with one agent picked from the list. `backLabel` names where back returns. */
export function showAgentActions(
  agent: Agent,
  backLabel = "Back to agents",
  options: { withStart?: boolean | undefined } = {},
): Effect.Effect<AgentAction, never, never> {
  const withStart = options.withStart ?? true;
  return Effect.async<AgentAction>((resume) => {
    store.setActiveMenu(
      {
        kind: "menu",
        title: agent.name,
        options: [
          ...(withStart
            ? [
                {
                  label: "Start a conversation",
                  value: "start" as const,
                  hint: agentModelString(agent.config.llm),
                },
              ]
            : []),
          { label: "Details", value: "details", hint: "model, tools, access" } as const,
          { label: "Edit", value: "edit", hint: "change its model, persona or tools" },
          { label: "Delete", value: "delete", hint: "asks first" },
          { label: backLabel, value: "back" },
        ],
      },
      (result) =>
        resume(Effect.succeed(result.kind === "exit" ? "back" : (result.value as AgentAction))),
    );
  });
}

/**
 * Ask before deleting, with keeping the agent as the default, and say what goes and what stays:
 * the agent's file goes, its saved conversations stay on disk but no longer appear in resume.
 */
export function confirmAndDeleteAgent(agent: Agent) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const history = yield* loadHistory(agent.id).pipe(
      Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
    );
    const saved = history.conversations.length;
    const keeps =
      saved === 0
        ? "It has no saved conversations."
        : `Its ${String(saved)} saved ${saved === 1 ? "conversation stays" : "conversations stay"} on disk, but resume stops listing ${saved === 1 ? "it" : "them"}.`;
    const answer = yield* terminal.select<"keep" | "delete">(
      `Delete ${agent.name}? This removes its settings, persona choice and tool access. ${keeps}`,
      {
        choices: [
          { name: `Keep ${agent.name}`, value: "keep" },
          {
            name: `Delete ${agent.name}`,
            value: "delete",
            tag: "can't be undone",
            tagTone: "warning",
          },
        ],
        default: "keep",
      },
    );
    if (answer !== "delete") {
      return false;
    }
    const outcome = yield* deleteAgentCommand(agent.id, { skipConfirmation: true }).pipe(
      Effect.either,
    );
    if (outcome._tag === "Left") {
      yield* terminal.error(`${agent.name} was not deleted: ${String(outcome.left)}`);
      return false;
    }
    return true;
  });
}

/** models.dev pricing for an agent's model, skipped for local models that cost nothing. */
export function modelMetadataFor(agent: Agent) {
  return isZeroCostLocalModel(agent.config.llm.provider, agent.config.llm.model)
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () => getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
        catch: (error) => error,
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

/** The server a local-model agent talks to, for the details screen. */
export function localHostUrlFor(agent: Agent) {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    return isLocalServerProvider(agent.config.llm.provider) &&
      (agent.config.llm.provider !== "ollama" || !isOllamaCloudModel(agent.config.llm.model))
      ? llmService.resolveLocalProviderBaseUrl(agent.config.llm.provider, appConfig.llm)
      : undefined;
  });
}
