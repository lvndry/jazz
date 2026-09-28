import { formatRelativeWhen } from "@jazz/adapters/history/conversation-search";
import type {
  ActiveHome,
  ActiveHomeAction,
  ActiveHomeConversation,
  ActiveHomeDetection,
  ActiveHomeStatus,
} from "../ui/store";

/** How many conversations the home screen offers to reopen; each takes a number key. */
export const HOME_CONVERSATION_LIMIT = 3;

/** Hours of the day at which the greeting turns to afternoon and to evening. */
const AFTERNOON_HOUR = 12;
const EVENING_HOUR = 18;

/** Menu values the wizard routes on. Conversations use `open:<agentId>:<conversationId>`. */
export type HomeActionValue =
  | "new-conversation"
  | "pick-agent"
  | "create-agent"
  | "create-agent:ollama"
  | "resume-conversation"
  | "list-agents"
  | "config"
  | "exit";

const OPEN_PREFIX = "open:";

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < AFTERNOON_HOUR) return "Good morning.";
  if (hour < EVENING_HOUR) return "Good afternoon.";
  return "Good evening.";
}

export interface HomeConversationSource {
  readonly agentId: string;
  readonly agentName: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messageCount: number;
}

export function openConversationValue(agentId: string, conversationId: string): string {
  return `${OPEN_PREFIX}${agentId}:${conversationId}`;
}

/** The agent and conversation a home value opens, or null when it is not a conversation. */
export function parseOpenConversationValue(
  value: string,
): { readonly agentId: string; readonly conversationId: string } | null {
  if (!value.startsWith(OPEN_PREFIX)) return null;
  const rest = value.slice(OPEN_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return { agentId: rest.slice(0, separator), conversationId: rest.slice(separator + 1) };
}

function lastActivityMs(source: HomeConversationSource): number {
  return new Date(source.endedAt ?? source.startedAt).getTime();
}

/**
 * The conversations home offers: those waiting on the user first, then the most recent, up to
 * {@link HOME_CONVERSATION_LIMIT}, keyed 1, 2, 3 in that order.
 */
export function homeConversations(
  sources: readonly HomeConversationSource[],
  waiting: ReadonlyMap<string, string>,
  nowMs: number,
): ActiveHomeConversation[] {
  const ordered = [...sources].sort(
    (left, right) =>
      Number(waiting.has(right.conversationId)) - Number(waiting.has(left.conversationId)) ||
      lastActivityMs(right) - lastActivityMs(left),
  );
  return ordered.slice(0, HOME_CONVERSATION_LIMIT).map((source, index) => {
    const waitingOn = waiting.get(source.conversationId);
    return {
      key: String(index + 1),
      value: openConversationValue(source.agentId, source.conversationId),
      title: source.title,
      agent: source.agentName,
      detail:
        waitingOn ??
        `${String(source.messageCount)} ${source.messageCount === 1 ? "message" : "messages"}`,
      age: formatRelativeWhen(lastActivityMs(source), nowMs),
      waiting: waitingOn !== undefined,
    };
  });
}

export interface HomeActionsInput {
  readonly agentCount: number;
  readonly defaultAgentName: string | undefined;
  readonly hasHistory: boolean;
  /** Models a running local Ollama serves, when one answered; offered as a first-run fast path. */
  readonly ollamaModels?: number;
}

export function homeActions(input: HomeActionsInput): ActiveHomeAction[] {
  if (input.agentCount === 0) {
    return [
      { key: "enter", label: "start setup", value: "create-agent" },
      ...(input.ollamaModels !== undefined && input.ollamaModels > 0
        ? [{ key: "o", label: "use Ollama, no key needed", value: "create-agent:ollama" }]
        : []),
      { key: "s", label: "settings", value: "config" },
      { key: "q", label: "quit", value: "exit" },
    ];
  }
  const actions: ActiveHomeAction[] = [
    {
      key: "enter",
      label:
        input.defaultAgentName === undefined
          ? "new conversation"
          : `new conversation with ${input.defaultAgentName}`,
      value: "new-conversation",
    },
  ];
  if (input.agentCount > 1) {
    actions.push({ key: "a", label: "another agent", value: "pick-agent" });
  }
  actions.push({ key: "n", label: "new agent", value: "create-agent" });
  if (input.hasHistory) {
    actions.push({ key: "r", label: "resume", value: "resume-conversation" });
  }
  actions.push(
    { key: "l", label: "agents", value: "list-agents" },
    { key: "s", label: "settings", value: "config" },
    { key: "q", label: "quit", value: "exit" },
  );
  return actions;
}

export function homeStatus(input: {
  readonly agentCount: number;
  readonly providerCount: number;
}): ActiveHomeStatus[] {
  if (input.agentCount === 0) return [];
  const parts: ActiveHomeStatus[] = [
    { text: `${String(input.agentCount)} ${input.agentCount === 1 ? "agent" : "agents"}` },
  ];
  parts.push(
    input.providerCount === 0
      ? { text: "no model provider has a key", tone: "warning", fixKey: "s" }
      : {
          text: `${String(input.providerCount)} ${input.providerCount === 1 ? "provider" : "providers"} ready`,
        },
  );
  return parts;
}

export function buildHome(input: {
  readonly now: Date;
  readonly conversations: readonly ActiveHomeConversation[];
  readonly actions: readonly ActiveHomeAction[];
  readonly status: readonly ActiveHomeStatus[];
  readonly detected?: readonly ActiveHomeDetection[];
  readonly firstRun: boolean;
}): ActiveHome {
  return {
    kind: "home",
    greeting: input.firstRun ? "" : greetingFor(input.now),
    conversations: input.conversations,
    actions: input.actions,
    status: input.status,
    ...(input.firstRun ? { firstRun: { detected: input.detected ?? [] } } : {}),
  };
}
