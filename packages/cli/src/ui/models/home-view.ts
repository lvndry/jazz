/**
 * The home screen as data both renderers paint: which agent a new conversation goes to, the
 * recent agents to pick from, what is waiting for you and how each piece is worded. The
 * fullscreen screen lays it out in bands; the Ink screen reads it as sentences. What a key does
 * on home is decided here too, so the two renderers cannot disagree.
 */

import type { ActiveHome, ActiveHomeAgent, ActiveHomeWaiting } from "../store";

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

/** The agent ↑ or ↓ moves the choice to, stopping at either end. */
export function stepTarget(
  model: Pick<HomeModel, "agents">,
  selectedId: string | undefined,
  delta: number,
): string | undefined {
  const current = targetAgent(model, selectedId);
  if (current === undefined) {
    return undefined;
  }
  const index = model.agents.indexOf(current);
  const next = Math.max(0, Math.min(model.agents.length - 1, index + delta));
  return model.agents[next]?.id;
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

// ─── Keys ────────────────────────────────────────────────────────────────────

export interface HomeKey {
  readonly name: string;
  readonly sequence?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
}

/** What a key does on home, given what is typed in the composer. */
export type HomeIntent =
  | { readonly kind: "move"; readonly agentId: string | undefined }
  | {
      readonly kind: "answer";
      readonly value: string;
      /** The composer's text, sent as the first message or kept across the agent picker. */
      readonly text?: string;
    }
  | { readonly kind: "type" }
  /** Esc empties the composer. Home never closes on esc; q quits. */
  | { readonly kind: "clear" };

/**
 * The key's meaning. Arrows choose the agent. Enter starts a conversation with it, sending what
 * is typed. Tab opens every agent, keeping what is typed. The single keys in the footer and the
 * waiting numbers only act while the composer is empty; once you type, every key is text.
 */
export function homeIntent(
  model: HomeModel,
  selectedId: string | undefined,
  draft: string,
  key: HomeKey,
): HomeIntent {
  if (key.name === "up" || key.name === "down") {
    return { kind: "move", agentId: stepTarget(model, selectedId, key.name === "up" ? -1 : 1) };
  }
  if (key.name === "escape") {
    return { kind: "clear" };
  }
  if (model.firstRun !== undefined) {
    const pressed = key.name === "return" || key.name === "enter" ? "enter" : key.sequence;
    const action = model.keys.find((entry) => entry.key === pressed);
    return action === undefined ? { kind: "type" } : { kind: "answer", value: action.value };
  }
  if (key.name === "return" || key.name === "enter") {
    const agent = targetAgent(model, selectedId);
    return agent === undefined
      ? { kind: "type" }
      : { kind: "answer", value: `${START_PREFIX}${agent.id}`, text: draft };
  }
  if (key.name === "tab") {
    return { kind: "answer", value: PICK_AGENT, text: draft };
  }
  if (draft.length === 0 && key.ctrl !== true && key.meta !== true && key.sequence !== undefined) {
    const shortcut =
      model.keys.find((entry) => entry.key === key.sequence) ??
      model.waiting.find((entry) => entry.key === key.sequence);
    if (shortcut !== undefined) {
      return { kind: "answer", value: shortcut.value };
    }
  }
  return { kind: "type" };
}

/** The agent a start value names, or undefined. */
export function startedAgentId(value: string): string | undefined {
  return value.startsWith(START_PREFIX) ? value.slice(START_PREFIX.length) : undefined;
}

// ─── Wording both renderers share ────────────────────────────────────────────

/** The footer keys as "n new agent · r resume · …". */
export function footerKeysText(model: HomeModel, separator = " · "): string {
  return model.keys.map((entry) => `${entry.key} ${entry.label}`).join(separator);
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
  selectedId: string | undefined,
): {
  readonly start?: string;
  readonly agentsHeading: string;
  readonly agents: readonly {
    readonly id: string;
    readonly text: string;
    readonly selected: boolean;
  }[];
  readonly waitingHeading?: string;
  readonly waiting: readonly string[];
  readonly footer: string;
} {
  const target = targetAgent(model, selectedId);
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
      selected: agent.id === target?.id,
    })),
    ...(model.waiting.length === 0
      ? {}
      : { waitingHeading: `Waiting for you, ${String(model.waiting.length)}` }),
    waiting: model.waiting.map(
      (entry) =>
        `${entry.key}  ${entry.title}, ${entry.agent}, ${waitingPhrase(entry.reason, entry.age)}`,
    ),
    footer: [
      footerKeysText(model),
      ...(model.warning === undefined ? [] : [model.warning.text]),
    ].join(" · "),
  };
}
