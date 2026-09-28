/**
 * The home screen as data both renderers paint: which agent a new conversation goes to, the
 * recent agents to pick from, what is waiting for you and how each piece is worded. The
 * fullscreen screen lays it out in bands; the Ink screen reads it as sentences. What a key does
 * on home is decided here too, so the two renderers cannot disagree.
 */

import type { ActiveHome, ActiveHomeAgent, ActiveHomeCommand, ActiveHomeWaiting } from "../store";
import { rankCommands } from "../suggestion-menu";

export type HomeAgent = ActiveHomeAgent;
export type HomeWaiting = ActiveHomeWaiting;

/** The home surface plus what only the screen knows: the version. */
export interface HomeModel extends Omit<ActiveHome, "kind"> {
  readonly version: string;
}

/** How many agents home offers beside the full picker. */
export const RECENT_AGENT_LIMIT = 5;

/** A readable title never runs past this many characters; longer ones end in "…". */
export const TITLE_MAX_LENGTH = 48;

export const COMPOSER_PLACEHOLDER = "Or type your first message";
export const FIRST_RUN_PITCH = "One agent for your email, calendar, files and the web.";
export const FIRST_RUN_PROMISE = "It asks before it touches anything real.";
export const FIRST_RUN_SETUP_LEAD = "Setup takes about a minute:";
export const FIRST_RUN_STEPS = ["pick a model", "name your agent", "say hello"] as const;

/** Values home answers with; a conversation opens as `open:<agentId>:<conversationId>`. */
export const START_PREFIX = "start:";
export const PICK_AGENT = "pick-agent";

// ─── Agents ──────────────────────────────────────────────────────────────────

/** What the default persona is called on screen: it is the everyday assistant. */
export function personaLabel(persona: string): string {
  return persona === "default" ? "everyday" : persona;
}

export interface AgentUsage {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly persona: string;
  /** When a conversation with it last happened, if ever. */
  readonly lastUsedMs?: number;
}

/**
 * The agents home offers, most recent first: the last-used agent leads (it is the default), then
 * by when each was last in a conversation, then by name for agents never used.
 */
export function orderRecentAgents(
  agents: readonly AgentUsage[],
  lastUsedAgentId: string | null,
  limit: number = RECENT_AGENT_LIMIT,
): AgentUsage[] {
  return [...agents]
    .sort(
      (left, right) =>
        Number(right.id === lastUsedAgentId) - Number(left.id === lastUsedAgentId) ||
        (right.lastUsedMs ?? -1) - (left.lastUsedMs ?? -1) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

/** The agent a new conversation goes to: the chosen one, else the first offered. */
export function targetAgent(
  model: Pick<HomeModel, "agents">,
  selectedId: string | undefined,
): HomeAgent | undefined {
  return model.agents.find((agent) => agent.id === selectedId) ?? model.agents[0];
}

// ─── Titles ──────────────────────────────────────────────────────────────────

export interface TitleSources {
  /** A goal's or loop's name, such as `organize-downloads`. */
  readonly workName?: string;
  /** What the work was asked to do. */
  readonly objective?: string;
  /** The saved conversation's title, which is usually its first message. */
  readonly conversationTitle?: string;
  readonly agentName: string;
}

const ID_LIKE = /^[0-9a-f-]{6,}$/i;
const UNTITLED = /^untitled( conversation)?$/i;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const GITHUB_ITEM = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)/;
const GITHUB_REPO = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/?$/;

/** A URL as a person would name it: "pull request #660 in lvndry/jazz", a repo, or its host. */
function nameUrl(url: string): string {
  const item = GITHUB_ITEM.exec(url);
  if (item !== null) {
    return `${item[2] === "pull" ? "pull request" : "issue"} #${item[3] ?? ""} in ${item[1] ?? ""}`;
  }
  const repo = GITHUB_REPO.exec(url);
  if (repo !== null) {
    return repo[1] ?? url;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const kept = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "");
  return `${kept}…`;
}

/** A work name as words: `organize-downloads` → "Organize downloads". Ids are not names. */
function nameAsWords(name: string | undefined): string | undefined {
  if (name === undefined || ID_LIKE.test(name.trim())) {
    return undefined;
  }
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? undefined : capitalize(words);
}

/**
 * Free text as a title: without a leading slash command, with URLs named, cut to its first
 * sentence. A title that was already cut mid-word loses the broken word.
 */
function textAsTitle(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  let title = text.replace(/\s+/g, " ").trim();
  if (UNTITLED.test(title)) {
    return undefined;
  }
  title = title.replace(/^\/[a-z][\w-]*\s*/i, "");
  if (title.endsWith("…")) {
    title = title.slice(0, -1).replace(/\s*\S*$/, "");
  }
  title = title.replace(URL_PATTERN, (url) => nameUrl(url));
  const sentence = title.split(/(?<=[.?!])\s/)[0] ?? title;
  const cleaned = sentence.replace(/[.\s]+$/, "").trim();
  if (cleaned.length === 0 || ID_LIKE.test(cleaned)) {
    return undefined;
  }
  return cutAtWord(capitalize(cleaned), TITLE_MAX_LENGTH);
}

/**
 * What a conversation is about, in words: the work's name, else what it was asked to do, else its
 * first message. Never "untitled conversation", a raw URL or an id.
 */
export function readableTitle(sources: TitleSources): string {
  return (
    nameAsWords(sources.workName) ??
    textAsTitle(sources.objective) ??
    textAsTitle(sources.conversationTitle) ??
    `A conversation with ${sources.agentName}`
  );
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

export type WaitingReason = "question" | "approval" | "review" | "stopped";

/** A conversation whose goal or loop can go no further until you act. */
export interface WaitingSource extends TitleSources {
  readonly agentId: string;
  readonly conversationId: string;
  readonly reason: WaitingReason;
  /** The question, the decision it needs, or why it stopped. */
  readonly detail?: string;
  /** Relative age, already worded: "1d ago". */
  readonly age: string;
}

/** What the right-hand tag says a waiting conversation needs, and since when. */
export function waitingTag(reason: WaitingReason, age: string): string {
  const short = age.replace(/ ago$/, "");
  switch (reason) {
    case "question":
      return `asked ${age}`;
    case "approval":
      return `needs approval · ${short}`;
    case "review":
      return `needs review · ${short}`;
    case "stopped":
      return `stopped · ${short}`;
  }
}

/** The same need, as a sentence ends for the Ink reading: "asked you 1d ago". */
export function waitingPhrase(reason: WaitingReason, age: string): string {
  switch (reason) {
    case "question":
      return `asked you ${age}`;
    case "approval":
      return "needs your approval";
    case "review":
      return "needs your review";
    case "stopped":
      return `stopped ${age}`;
  }
}

/** The waiting section, numbered 1–N in the order given. */
export function waitingEntries(sources: readonly WaitingSource[]): HomeWaiting[] {
  return sources.map((source, index) => ({
    key: String(index + 1),
    value: openConversationValue(source.agentId, source.conversationId),
    title: readableTitle(source),
    agent: source.agentName,
    reason: source.reason,
    age: source.age,
    ...(source.detail === undefined || source.detail.trim().length === 0
      ? {}
      : { detail: source.detail.replace(/\s+/g, " ").trim() }),
  }));
}

export function openConversationValue(agentId: string, conversationId: string): string {
  return `open:${agentId}:${conversationId}`;
}

/** The agent and conversation a home value opens, or null when it is not a conversation. */
export function parseOpenConversationValue(
  value: string,
): { readonly agentId: string; readonly conversationId: string } | null {
  if (!value.startsWith("open:")) {
    return null;
  }
  const rest = value.slice("open:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  return { agentId: rest.slice(0, separator), conversationId: rest.slice(separator + 1) };
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** What `/` offers on home. Starting a conversation needs no command: enter does it. */
export const HOME_COMMANDS: readonly ActiveHomeCommand[] = [
  { name: "new", description: "create an agent", value: "create-agent" },
  { name: "resume", description: "continue an earlier conversation", value: "resume-conversation" },
  { name: "agents", description: "see, edit or delete your agents", value: "list-agents" },
  { name: "settings", description: "providers, keys, theme and limits", value: "config" },
  { name: "quit", description: "leave jazz", value: "exit" },
];

/** The home commands matching what is typed after `/`, or undefined when no menu is open. */
export function homeCommandMatches(
  model: Pick<HomeModel, "commands">,
  draft: string,
): readonly ActiveHomeCommand[] | undefined {
  const query = slashQuery(draft);
  return query === undefined ? undefined : rankCommands(model.commands, query);
}

/** The text after `/` while a command is still being chosen: no space, no newline yet. */
export function slashQuery(draft: string): string | undefined {
  if (!draft.startsWith("/") || /\s/.test(draft.slice(1))) {
    return undefined;
  }
  return draft.slice(1);
}

/** The home command a finished line names, such as "/resume" with arguments after it. */
function commandNamed(
  model: Pick<HomeModel, "commands">,
  draft: string,
): ActiveHomeCommand | undefined {
  const name = draft.slice(1).split(/\s/)[0]?.toLowerCase() ?? "";
  return model.commands.find((command) => command.name === name);
}

// ─── Focus and keys ──────────────────────────────────────────────────────────

/**
 * Where home is, in one value both renderers hold. `agentId` is who a new conversation goes to;
 * it is kept while a waiting conversation is selected, so typing returns to it. `commandIndex`
 * is the selection in the slash menu, and in the first-run list.
 */
export interface HomeState {
  readonly agentId: string | undefined;
  /** The waiting conversation selected with ↓, if any; enter then opens it. */
  readonly waitingValue: string | undefined;
  readonly draft: string;
  readonly commandIndex: number;
}

export function initialHomeState(model: HomeModel): HomeState {
  return {
    agentId: model.targetAgentId ?? model.agents[0]?.id,
    waitingValue: undefined,
    draft: model.draft ?? "",
    commandIndex: 0,
  };
}

export interface HomeKey {
  readonly name: string;
  readonly sequence?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
}

/** What a key does on home. */
export type HomeIntent =
  /**
   * Move to `patch`. With `edit`, the renderer then applies the key to the draft as text: home
   * has no single-key actions, so every letter and digit types.
   */
  | { readonly kind: "state"; readonly patch: Partial<HomeState>; readonly edit: boolean }
  | {
      readonly kind: "answer";
      readonly value: string;
      /** The composer's text, sent as the first message or kept across the agent picker. */
      readonly text?: string;
    }
  | { readonly kind: "quit" };

/** The selection order ↑↓ walks: the recent agents, then the waiting conversations. */
function focusOrder(
  model: HomeModel,
): readonly { readonly agentId?: string; readonly waitingValue?: string }[] {
  return [
    ...model.agents.map((agent) => ({ agentId: agent.id })),
    ...model.waiting.map((entry) => ({ waitingValue: entry.value })),
  ];
}

function moveFocus(model: HomeModel, state: HomeState, delta: number): Partial<HomeState> {
  const order = focusOrder(model);
  const current = order.findIndex((entry) =>
    state.waitingValue !== undefined
      ? entry.waitingValue === state.waitingValue
      : entry.agentId === targetAgent(model, state.agentId)?.id,
  );
  const next = order[Math.max(0, Math.min(order.length - 1, current + delta))];
  if (next === undefined) {
    return {};
  }
  return next.waitingValue !== undefined
    ? { waitingValue: next.waitingValue }
    : { agentId: next.agentId, waitingValue: undefined };
}

const NO_CHANGE: HomeIntent = { kind: "state", patch: {}, edit: false };

function isEnter(key: HomeKey): boolean {
  return key.name === "return" || key.name === "enter";
}

/**
 * The key's meaning.
 *
 * - `/` opens the command menu: ↑↓ choose in it, tab completes, enter runs the command. The
 *   conversation is not started.
 * - Otherwise ↑↓ move through the agents and on into "Waiting for you". Enter starts a
 *   conversation with the chosen agent and sends what is typed, or opens the selected waiting
 *   conversation. Tab opens every agent, keeping the draft.
 * - Typing while a waiting conversation is selected goes back to the agent, so enter never
 *   drops a draft into a conversation it was not written for.
 * - Esc clears the draft; on an empty composer it quits, as ctrl+c does.
 */
export function homeIntent(model: HomeModel, state: HomeState, key: HomeKey): HomeIntent {
  if (key.ctrl === true && key.name === "c") {
    return { kind: "quit" };
  }
  if (model.firstRun !== undefined) {
    return firstRunIntent(model, state, key);
  }
  if (key.name === "escape") {
    return state.draft.length > 0
      ? { kind: "state", patch: { draft: "", commandIndex: 0 }, edit: false }
      : { kind: "quit" };
  }
  const matches = homeCommandMatches(model, state.draft);
  if (matches !== undefined) {
    if (key.name === "up" || key.name === "down") {
      const index = Math.max(
        0,
        Math.min(matches.length - 1, state.commandIndex + (key.name === "up" ? -1 : 1)),
      );
      return { kind: "state", patch: { commandIndex: index }, edit: false };
    }
    const chosen = matches[Math.min(state.commandIndex, matches.length - 1)];
    if (isEnter(key)) {
      return chosen === undefined ? NO_CHANGE : { kind: "answer", value: chosen.value };
    }
    if (key.name === "tab") {
      return chosen === undefined
        ? NO_CHANGE
        : { kind: "state", patch: { draft: `/${chosen.name}`, commandIndex: 0 }, edit: false };
    }
    return { kind: "state", patch: { commandIndex: 0 }, edit: true };
  }
  if (isEnter(key) && state.draft.startsWith("/")) {
    const command = commandNamed(model, state.draft);
    return command === undefined ? NO_CHANGE : { kind: "answer", value: command.value };
  }
  if (key.name === "up" || key.name === "down") {
    return {
      kind: "state",
      patch: moveFocus(model, state, key.name === "up" ? -1 : 1),
      edit: false,
    };
  }
  if (isEnter(key)) {
    if (state.waitingValue !== undefined) {
      return { kind: "answer", value: state.waitingValue };
    }
    const agent = targetAgent(model, state.agentId);
    return agent === undefined
      ? NO_CHANGE
      : { kind: "answer", value: `${START_PREFIX}${agent.id}`, text: state.draft };
  }
  if (key.name === "tab") {
    return { kind: "answer", value: PICK_AGENT, text: state.draft };
  }
  return {
    kind: "state",
    patch: { waitingValue: undefined, commandIndex: 0 },
    edit: true,
  };
}

function firstRunIntent(model: HomeModel, state: HomeState, key: HomeKey): HomeIntent {
  const actions = model.firstRun?.actions ?? [];
  if (key.name === "escape") {
    return { kind: "quit" };
  }
  if (key.name === "up" || key.name === "down") {
    const index = Math.max(
      0,
      Math.min(actions.length - 1, state.commandIndex + (key.name === "up" ? -1 : 1)),
    );
    return { kind: "state", patch: { commandIndex: index }, edit: false };
  }
  if (isEnter(key)) {
    const action = actions[state.commandIndex];
    return action === undefined ? NO_CHANGE : { kind: "answer", value: action.value };
  }
  return NO_CHANGE;
}

/** The agent a start value names, or undefined. */
export function startedAgentId(value: string): string | undefined {
  return value.startsWith(START_PREFIX) ? value.slice(START_PREFIX.length) : undefined;
}

// ─── Wording both renderers share ────────────────────────────────────────────

/** The waiting conversation the selection is on, if any. */
export function focusedWaiting(model: HomeModel, state: HomeState): HomeWaiting | undefined {
  return state.waitingValue === undefined
    ? undefined
    : model.waiting.find((entry) => entry.value === state.waitingValue);
}

/** What enter will do right now, in words, for the composer's hint. */
export function enterHint(model: HomeModel, state: HomeState): string | undefined {
  const matches = homeCommandMatches(model, state.draft);
  if (matches !== undefined) {
    const chosen = matches[Math.min(state.commandIndex, matches.length - 1)];
    return chosen === undefined ? "no command by that name" : `enter runs /${chosen.name}`;
  }
  const waiting = focusedWaiting(model, state);
  if (waiting !== undefined) {
    return `enter opens ${waiting.title}`;
  }
  const agent = targetAgent(model, state.agentId);
  return agent === undefined ? undefined : `enter sends to ${agent.name}`;
}

/** The footer's hints, left to right. */
export function footerHints(
  model: HomeModel,
): readonly { readonly key: string; readonly label: string }[] {
  return [
    { key: "/", label: "commands" },
    ...(model.waiting.length > 0 ? [{ key: "↓", label: "waiting" }] : []),
    { key: "tab", label: "all agents" },
    { key: "esc", label: "quit" },
  ];
}

/** "↑↓ choose · tab all 31" beside the agents heading. */
export function agentsHint(model: HomeModel): string {
  return model.agentCount > model.agents.length
    ? `↑↓ choose · tab all ${String(model.agentCount)}`
    : "↑↓ choose · tab search";
}

/** What first run found, as the sentence it reads as: "Found X …", then "and Y …". */
export function detectionLines(
  model: HomeModel,
): readonly { readonly lead: string; readonly label: string; readonly detail: string }[] {
  return (model.firstRun?.detected ?? []).map((detection, index) => ({
    lead: index === 0 ? "Found" : "and",
    label: detection.label,
    detail: detection.detail,
  }));
}

/** Home read top to bottom as complete sentences, for screen readers and plain terminals. */
export function homeSentences(
  model: HomeModel,
  state: HomeState,
): {
  readonly start?: string;
  readonly agentsHeading: string;
  readonly agents: readonly {
    readonly id: string;
    readonly text: string;
    readonly selected: boolean;
  }[];
  readonly waitingHeading?: string;
  readonly waiting: readonly {
    readonly value: string;
    readonly text: string;
    readonly selected: boolean;
  }[];
  readonly footer: string;
} {
  const target = targetAgent(model, state.agentId);
  const onWaiting = state.waitingValue !== undefined;
  return {
    ...(target === undefined
      ? {}
      : { start: `New conversation with ${target.name} (${target.model})` }),
    agentsHeading: `Your agents, ${String(model.agentCount)}`,
    agents: model.agents.map((agent) => ({
      id: agent.id,
      text: [
        agent.name,
        agent.model,
        personaLabel(agent.persona),
        agent.lastUsed === undefined ? "not used yet" : `used ${agent.lastUsed}`,
      ].join(", "),
      selected: !onWaiting && agent.id === target?.id,
    })),
    ...(model.waiting.length === 0
      ? {}
      : { waitingHeading: `Waiting for you, ${String(model.waiting.length)}` }),
    waiting: model.waiting.map((entry) => ({
      value: entry.value,
      text: `${entry.title}, ${entry.agent}, ${waitingPhrase(entry.reason, entry.age)}`,
      selected: entry.value === state.waitingValue,
    })),
    footer: [
      footerHints(model)
        .map((hint) => `${hint.key} ${hint.label}`)
        .join(" · "),
      ...(model.warning === undefined ? [] : [`${model.warning.text} (${model.warning.fix})`]),
    ].join(" · "),
  };
}
