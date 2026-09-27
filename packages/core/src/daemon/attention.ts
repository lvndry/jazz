/**
 * @fileoverview What the daemon owes the person who runs it: telling them when something needs
 * them, and stopping its own work when they say so or when it has spent its daily allowance.
 *
 * Pure rules over plain data; the stores, the notifier, and the routes live in adapters.
 */

import { z } from "zod";
import type { RunRecord } from "@/core/agent/run/run-record";
import type { DaemonConfig } from "@/core/types/config";

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

export interface UnattendedSpend {
  readonly runs: number;
  readonly totalTokens: number;
  /** Absent while any counted run has no price. */
  readonly costUSD?: number;
  readonly costKnown: boolean;
}

/**
 * What unattended runs started since local midnight have spent. A run that started yesterday
 * counts toward yesterday even if it finished today; a chat's runs never count.
 */
export function unattendedSpendToday(
  records: readonly Pick<RunRecord, "unattended" | "createdAt" | "totalTokens" | "costUSD">[],
  now: Date,
): UnattendedSpend {
  const since = startOfLocalDay(now).getTime();
  let runs = 0;
  let totalTokens = 0;
  let costUSD = 0;
  let costKnown = true;
  for (const record of records) {
    if (record.unattended !== true || Date.parse(record.createdAt) < since) {
      continue;
    }
    runs += 1;
    totalTokens += record.totalTokens ?? 0;
    if (record.costUSD === undefined) {
      costKnown = false;
    } else {
      costUSD += record.costUSD;
    }
  }
  return costKnown ? { runs, totalTokens, costUSD, costKnown } : { runs, totalTokens, costKnown };
}

/** Whether the person lifted the daily cap for the rest of the day by resuming. */
export function capLifted(state: DaemonState, now: Date): boolean {
  return state.capLiftedUntil !== undefined && Date.parse(state.capLiftedUntil) > now.getTime();
}

/** The daily cap today's spend has reached, or undefined while the daemon may keep working. */
export function dailyCapReached(
  config: DaemonConfig | undefined,
  spend: UnattendedSpend,
): DailyLimit | undefined {
  if (
    config?.dailyCostUSD !== undefined &&
    spend.costKnown &&
    (spend.costUSD ?? 0) >= config.dailyCostUSD
  ) {
    return "cost";
  }
  if (config?.dailyTokens !== undefined && spend.totalTokens >= config.dailyTokens) {
    return "tokens";
  }
  return undefined;
}

/** Something that cannot go on until the person answers or looks at it. */
export type WaitingKind =
  "approval" | "question" | "file" | "goal-review" | "goal-limit" | "loop-stopped";

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
