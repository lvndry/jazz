/**
 * The home screen's content, as data both renderers paint. The fullscreen screen lays it out in
 * bands and a legend; the Ink screen reads it as a list for screen readers and plain terminals.
 * Wording, order and which keys exist are decided here and nowhere else.
 */

import type {
  ActiveHome,
  ActiveHomeAction,
  ActiveHomeConversation,
  ActiveHomeStatus,
} from "../store";

/** The home surface plus what only the screen knows: the version and the working directory. */
export interface HomeModel extends Omit<ActiveHome, "kind"> {
  readonly version: string;
  /** The working directory as a person reads it. */
  readonly cwd: string;
}

export type HomeConversation = ActiveHomeConversation;
export type HomeAction = ActiveHomeAction;
export type HomeStatus = ActiveHomeStatus;

export const FIRST_RUN_PITCH = "One agent for your email, calendar, files and the web.";
export const FIRST_RUN_PROMISE = "It asks before it touches anything real.";
export const FIRST_RUN_SETUP_LEAD = "Setup takes about a minute:";
export const FIRST_RUN_STEPS = ["pick a model", "name your agent", "say hello"] as const;

/** The sentence after the greeting: how many conversations wait, or an invitation to continue. */
export function homeLead(model: HomeModel): string {
  const waiting = model.conversations.filter((conversation) => conversation.waiting).length;
  if (waiting > 0) {
    return `${String(waiting)} ${waiting === 1 ? "conversation is" : "conversations are"} waiting for you.`;
  }
  return model.conversations.length > 0
    ? "Pick up where you left off, or start something new."
    : "";
}

/** A conversation's right-hand tag: its age, marked as waiting when the agent is blocked on you. */
export function conversationTag(conversation: HomeConversation): string {
  return conversation.waiting ? `waiting · ${conversation.age}` : conversation.age;
}

/** One key in the legend and what it does. */
export interface LegendEntry {
  readonly key: string;
  readonly label: string;
}

export interface HomeLegend {
  /** Enter, then the number keys when there are conversations to open. */
  readonly primary: readonly LegendEntry[];
  readonly rest: readonly LegendEntry[];
}

export function homeLegend(model: HomeModel): HomeLegend {
  const enter = model.actions.find((action) => action.key === "enter");
  const count = model.conversations.length;
  const primary: LegendEntry[] = enter === undefined ? [] : [{ key: "enter", label: enter.label }];
  if (count > 0) {
    primary.push({
      key: count === 1 ? "1" : `1–${String(count)}`,
      label: count === 1 ? "open it" : "open one",
    });
  }
  return {
    primary,
    rest: model.actions
      .filter((action) => action.key !== "enter")
      .map((action) => ({ key: action.key, label: action.label })),
  };
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

/** The status line as plain text, for renderers that read it out in one go. */
export function statusText(status: readonly HomeStatus[], separator: string): string {
  return status
    .map((part) => (part.fixKey === undefined ? part.text : `${part.text} (${part.fixKey} to fix)`))
    .join(separator);
}
