/**
 * @fileoverview What the daemon owes the person who runs it: telling them when something needs
 * them, and stopping its own work when they say so or when it has spent its daily allowance.
 *
 * Pure rules over plain data; the stores, the notifier, and the routes live in adapters. Spend
 * is read from the spend ledger (`spend/ledger.ts`) and capped by `spend/caps.ts`.
 */

import { z } from "zod";
import type { PendingInput } from "@/core/agent/run/run-state";

/** Why the daemon stopped starting work of its own. */
export type DaemonPause =
  | { readonly kind: "user"; readonly at: string }
  | {
      readonly kind: "daily-cap";
      readonly at: string;
      readonly limit: DailyLimit;
      /** When the day it capped ends and work starts again on its own. */
      readonly until: string;
    };

export type DailyLimit = "cost" | "tokens";

export interface DaemonState {
  readonly paused?: DaemonPause;
  /**
   * Set by resuming a daemon paused at its daily cap: the cap is not applied again before this
   * time, the end of that day, since today's spend is still over it.
   */
  readonly capLiftedUntil?: string;
  /** When each waiting item was announced, by `WaitingItem.key`, so it is announced once. */
  readonly notified: Readonly<Record<string, string>>;
}

export const EMPTY_DAEMON_STATE: DaemonState = { notified: {} };

const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "not a time");

const daemonStateSchema = z.object({
  paused: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), at: isoTime }),
      z.object({
        kind: z.literal("daily-cap"),
        at: isoTime,
        limit: z.enum(["cost", "tokens"]),
        until: isoTime,
      }),
    ])
    .optional(),
  capLiftedUntil: isoTime.optional(),
  notified: z.record(z.string(), isoTime),
});

/** A stored state, or the empty one for a missing or unreadable file: a lost record only re-announces. */
export function parseDaemonState(value: unknown): DaemonState {
  const parsed = daemonStateSchema.safeParse(value);
  return parsed.success ? (parsed.data as DaemonState) : EMPTY_DAEMON_STATE;
}

/** The pause in force at `now`: a daily-cap pause lifts on its own when its day is over. */
export function pauseInForce(state: DaemonState, now: Date): DaemonPause | undefined {
  const { paused } = state;
  if (paused?.kind === "daily-cap" && Date.parse(paused.until) <= now.getTime()) {
    return undefined;
  }
  return paused;
}

export function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function startOfNextLocalDay(now: Date): Date {
  const next = startOfLocalDay(now);
  next.setDate(next.getDate() + 1);
  return next;
}

/** What unattended runs spent today, from the spend ledger. */
export interface UnattendedSpend {
  readonly runs: number;
  readonly totalTokens: number;
  /** Absent while any counted run has no price. */
  readonly costUSD?: number;
  readonly costKnown: boolean;
}

/** Whether the person lifted the daily cap for the rest of the day by resuming. */
export function capLifted(state: DaemonState, now: Date): boolean {
  return state.capLiftedUntil !== undefined && Date.parse(state.capLiftedUntil) > now.getTime();
}

/** Something that cannot go on until the person answers or looks at it. */
export type WaitingKind =
  "approval" | "question" | "secret" | "file" | "goal-review" | "goal-limit" | "loop-stopped";

export interface WaitingItem {
  /** Changes whenever something new starts waiting, so each is announced once. */
  readonly key: string;
  readonly kind: WaitingKind;
  /** One line naming what waits and on what, like `Goal ship-docs wants to run rm -rf build`. */
  readonly title: string;
  /** More of what it asks, for a notification body or a listing. */
  readonly detail: string;
  readonly since: string;
  readonly runId?: string;
  readonly goalId?: string;
  readonly loopId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
}

/** The items not announced yet. */
export function newlyWaiting(
  items: readonly WaitingItem[],
  notified: DaemonState["notified"],
): WaitingItem[] {
  return items.filter((item) => notified[item.key] === undefined);
}

/** The announcement record kept only for items still waiting, so it never grows without bound. */
export function keepNotified(
  notified: DaemonState["notified"],
  items: readonly WaitingItem[],
): Record<string, string> {
  const waiting = new Set(items.map((item) => item.key));
  return Object.fromEntries(Object.entries(notified).filter(([key]) => waiting.has(key)));
}

/** What a parked run waits on from the person, in words. */
export function describePendingInput(pending: PendingInput): string {
  return pending.kind === "tool-approval"
    ? pending.request.message
    : pending.kind === "question"
      ? pending.request.question
      : pending.kind === "secret"
        ? pending.request.prompt
        : "a file to be picked";
}

/**
 * The waiting item for a parked run. `who` names what parked it ("Goal ship-docs", "Loop
 * deploy-watch", "A run"). The key is the same whoever builds it (the daemon's tick, or the run
 * the moment it parks), so the notify outbox announces it once.
 */
export function parkedRunWaitingItem(input: {
  readonly runId: string;
  readonly agentId: string;
  readonly pending: PendingInput;
  readonly since: string;
  readonly who: string;
  readonly conversationId?: string;
  readonly goalId?: string;
  readonly loopId?: string;
}): WaitingItem {
  const { pending, who } = input;
  const common = {
    since: input.since,
    runId: input.runId,
    agentId: input.agentId,
    detail: describePendingInput(pending),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
    ...(input.loopId !== undefined ? { loopId: input.loopId } : {}),
  };
  switch (pending.kind) {
    case "tool-approval":
      return {
        ...common,
        key: `run:${input.runId}:${pending.request.toolCallId}`,
        kind: "approval",
        title: `${who} wants to use ${pending.request.toolName}`,
      };
    case "question":
      return {
        ...common,
        key: `run:${input.runId}:${pending.toolCallId}`,
        kind: "question",
        title: `${who} has a question`,
      };
    case "file-picker":
      return {
        ...common,
        key: `run:${input.runId}:${pending.toolCallId}`,
        kind: "file",
        title: `${who} needs a file`,
      };
    case "secret":
      return {
        ...common,
        key: `run:${input.runId}:${pending.toolCallId}`,
        kind: "secret",
        title: `${who} needs a secret you type`,
      };
  }
}

/**
 * How to answer an item, for a notification body. From a chat a Jazz bridge serves, an approval
 * is answered with `/approve`; anywhere else with the shell command.
 */
export function answerHint(
  item: WaitingItem,
  options: { readonly fromChat?: boolean } = {},
): string {
  if (item.runId !== undefined && item.kind === "approval") {
    return options.fromChat === true
      ? `Reply /approve ${item.runId} or /deny ${item.runId}`
      : `jazz runs approve ${item.runId} (or reject)`;
  }
  if (item.runId !== undefined && item.kind === "question") {
    return `jazz runs answer ${item.runId} --response "<your answer>"`;
  }
  if (item.runId !== undefined && item.kind === "secret") {
    return `jazz runs secret ${item.runId} (in a terminal)`;
  }
  if (item.goalId !== undefined) {
    return `jazz goal show ${item.goalId.slice(0, 8)}`;
  }
  if (item.loopId !== undefined) {
    return `jazz loop show ${item.loopId.slice(0, 8)}`;
  }
  return "open jazz";
}

const waitingKinds = [
  "approval",
  "question",
  "secret",
  "file",
  "goal-review",
  "goal-limit",
  "loop-stopped",
] as const satisfies readonly WaitingKind[];

/** On-disk shape of a {@link WaitingItem}, for the notify outbox. */
export const WaitingItemSchema: z.ZodType<WaitingItem> = z.object({
  key: z.string(),
  kind: z.enum(waitingKinds),
  title: z.string(),
  detail: z.string(),
  since: z.string(),
  runId: z.string().exactOptional(),
  goalId: z.string().exactOptional(),
  loopId: z.string().exactOptional(),
  agentId: z.string().exactOptional(),
  conversationId: z.string().exactOptional(),
});

/** On-disk shape of a {@link DaemonPause}, for the notify outbox. */
export const DaemonPauseSchema: z.ZodType<DaemonPause> = daemonStateSchema.shape.paused.unwrap();
