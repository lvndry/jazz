import {
  RECENT_AGENT_LIMIT,
  orderRecentAgents,
  waitingEntries,
  type AgentUsage,
  type WaitingSource,
} from "../ui/models/home-view";
import type { ActiveHome, ActiveHomeDetection, ActiveHomeKey } from "../ui/store";

/** The footer's single keys, or first run's actions. */
export function homeKeys(input: {
  readonly firstRun: boolean;
  /** Models a running local Ollama serves, when one answered; a first-run fast path. */
  readonly ollamaModels?: number | undefined;
}): ActiveHomeKey[] {
  if (input.firstRun) {
    return [
      { key: "enter", label: "start setup", value: "create-agent" },
      ...(input.ollamaModels !== undefined && input.ollamaModels > 0
        ? [{ key: "o", label: "use Ollama, no key needed", value: "create-agent:ollama" }]
        : []),
      { key: "s", label: "settings", value: "config" },
      { key: "q", label: "quit", value: "exit" },
    ];
  }
  return [
    { key: "n", label: "new agent", value: "create-agent" },
    { key: "r", label: "resume", value: "resume-conversation" },
    { key: "l", label: "agents", value: "list-agents" },
    { key: "s", label: "settings", value: "config" },
    { key: "q", label: "quit", value: "exit" },
  ];
}

/** The footer warning, when no model provider can answer. */
export function homeWarning(providerCount: number): ActiveHome["warning"] {
  return providerCount === 0 ? { text: "no model provider has a key", fixKey: "s" } : undefined;
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
    keys: homeKeys({ firstRun, ollamaModels: input.ollamaModels }),
    ...(warning === undefined ? {} : { warning }),
    ...(firstRun ? { firstRun: { detected: input.detected ?? [] } } : {}),
  };
}
