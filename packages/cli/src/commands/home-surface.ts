import {
  HOME_COMMANDS,
  RECENT_AGENT_LIMIT,
  orderRecentAgents,
  waitingEntries,
  type AgentUsage,
  type WaitingSource,
} from "../ui/models/home-view";
import type { ActiveHome, ActiveHomeAction, ActiveHomeDetection } from "../ui/store";

/** First run's list: start setup, the Ollama fast path when one is running, then settings. */
export function firstRunActions(ollamaModels: number | undefined): ActiveHomeAction[] {
  return [
    { label: "Start setup", value: "create-agent" },
    ...(ollamaModels !== undefined && ollamaModels > 0
      ? [{ label: "Use Ollama, no key needed", value: "create-agent:ollama" }]
      : []),
    { label: "Settings", value: "settings" },
  ];
}

/** The footer warning, when no model provider can answer. */
export function homeWarning(providerCount: number): ActiveHome["warning"] {
  return providerCount === 0
    ? { text: "no model provider has a key", fix: "/settings" }
    : undefined;
}

export interface HomeInput {
  /** When this showing of home began; every refresh of it passes the same value. */
  readonly shownAt: number;
  readonly agents: readonly AgentUsage[];
  readonly lastUsedAgentId: string | null;
  /** Relative "last used" wording per agent id. */
  readonly lastUsedWords: ReadonlyMap<string, string>;
  readonly targetAgentId?: string | undefined;
  readonly draft?: string | undefined;
  readonly waiting: readonly WaitingSource[];
  readonly providerCount: number;
  readonly ollamaModels?: number | undefined;
  readonly detected?: readonly ActiveHomeDetection[] | undefined;
}

/**
 * The home surface. A target chosen in the full picker that is not among the recent agents is
 * put first, so the button and the list agree on who a new conversation goes to.
 */
export function buildHome(input: HomeInput): ActiveHome {
  const firstRun = input.agents.length === 0;
  const recent = orderRecentAgents(input.agents, input.lastUsedAgentId);
  const picked =
    input.targetAgentId === undefined || recent.some((agent) => agent.id === input.targetAgentId)
      ? undefined
      : input.agents.find((agent) => agent.id === input.targetAgentId);
  const offered =
    picked === undefined ? recent : [picked, ...recent.slice(0, RECENT_AGENT_LIMIT - 1)];
  const warning = homeWarning(input.providerCount);
  return {
    kind: "home",
    shownAt: input.shownAt,
    agents: offered.map((agent) => {
      const lastUsed = input.lastUsedWords.get(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        persona: agent.persona,
        ...(lastUsed === undefined ? {} : { lastUsed }),
      };
    }),
    agentCount: input.agents.length,
    ...(input.targetAgentId === undefined ? {} : { targetAgentId: input.targetAgentId }),
    ...(input.draft === undefined || input.draft.length === 0 ? {} : { draft: input.draft }),
    waiting: waitingEntries(input.waiting),
    commands: HOME_COMMANDS,
    ...(warning === undefined ? {} : { warning }),
    ...(firstRun
      ? {
          firstRun: {
            detected: input.detected ?? [],
            actions: firstRunActions(input.ollamaModels),
          },
        }
      : {}),
  };
}
