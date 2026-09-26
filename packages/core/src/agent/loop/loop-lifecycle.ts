/**
 * @fileoverview What a loop does next: when it is due, claiming a run, folding a finished run
 * in, and the user's controls. Pure functions over the record, shared by the daemon and every
 * surface that controls loops.
 */

import { addRunSpend, type RunSpend } from "@/core/agent/run/run-spend";
import { nextCronRun } from "@/core/utils/cron";
import type { ProcessOwner } from "@/core/utils/process";
import {
  DEFAULT_LOOP_BUDGET,
  MAX_CONSECUTIVE_LOOP_FAILURES,
  withoutRun,
  type LoopBudget,
  type LoopLastRun,
  type LoopLimit,
  type LoopRecord,
  type LoopRecordInput,
  type LoopSchedule,
} from "./loop-record";

/** Longest start of a run's answer or error kept on the loop for a listing. */
const SUMMARY_CHARS = 300;

/**
 * When the schedule next fires after `after`. Always measured from the moment asked, so runs
 * missed while the daemon was down collapse into one instead of firing back to back.
 */
export function nextRunAfter(schedule: LoopSchedule, after: Date): Date | undefined {
  return schedule.kind === "every"
    ? new Date(after.getTime() + schedule.everyMs)
    : nextCronRun(schedule.expression, after, schedule.timezone);
}

export function isLoopDue(loop: LoopRecord, now: Date): boolean {
  return (
    loop.state.kind === "active" &&
    loop.run === undefined &&
    Date.parse(loop.nextRunAt) <= now.getTime()
  );
}

/** The first cap the loop has reached, or undefined while it may start another run. */
export function loopLimitReached(
  loop: Pick<LoopRecord, "budget" | "usage">,
): LoopLimit | undefined {
  const { budget, usage } = loop;
  if (budget.maxRuns !== undefined && usage.runs >= budget.maxRuns) {
    return "runs";
  }
  if (usage.totalTokens >= budget.maxTokens) {
    return "tokens";
  }
  if (usage.activeDurationMs >= budget.maxDurationMs) {
    return "duration";
  }
  if (
    budget.maxCostUSD !== undefined &&
    usage.costKnown &&
    (usage.costUSD ?? 0) >= budget.maxCostUSD
  ) {
    return "cost";
  }
  return undefined;
}

/** What one run may still spend, from what the loop has left. */
export function loopRunCaps(loop: Pick<LoopRecord, "budget" | "usage">): {
  readonly maxTokens: number;
  readonly maxDurationMs: number;
  readonly maxCostUSD?: number;
} {
  const { budget, usage } = loop;
  const maxCostUSD =
    budget.maxCostUSD !== undefined && usage.costKnown
      ? budget.maxCostUSD - (usage.costUSD ?? 0)
      : undefined;
  return {
    maxTokens: Math.max(1, budget.maxTokens - usage.totalTokens),
    maxDurationMs: Math.max(1, budget.maxDurationMs - usage.activeDurationMs),
    ...(maxCostUSD !== undefined ? { maxCostUSD: Math.max(0, maxCostUSD) } : {}),
  };
}

/** The loop with a run claimed: counted, and marked in flight so no other run starts. */
export function claimLoopRun(
  loop: LoopRecord,
  runId: string,
  owner: ProcessOwner,
  now: Date,
): LoopRecordInput {
  return {
    ...withoutRun(loop),
    usage: { ...loop.usage, runs: loop.usage.runs + 1 },
    run: { runId, owner, startedAt: now.toISOString() },
  };
}

export interface LoopRunEnd {
  readonly outcome: LoopLastRun["outcome"];
  readonly spend?: RunSpend;
  /** The run's answer, or its error. */
  readonly text?: string;
  /** Set when the run asked to end the loop, with its reason. */
  readonly endRequested?: string;
}

function summaryOf(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  const characters = Array.from(trimmed);
  return characters.length <= SUMMARY_CHARS
    ? trimmed
    : `${characters.slice(0, SUMMARY_CHARS).join("")}…`;
}

/**
 * The loop once its in-flight run has ended. What it becomes follows one precedence: a stop
 * the user asked for, then the run's own request to end, then an expiry or run limit, then a
 * budget cap, then too many failures in a row; otherwise it waits for its next run.
 */
export function settleLoopRun(loop: LoopRecord, end: LoopRunEnd, now: Date): LoopRecordInput {
  const run = loop.run;
  const summary = summaryOf(end.text);
  const base: LoopRecordInput = {
    ...withoutRun(loop),
    usage: end.spend === undefined ? loop.usage : addRunSpend(loop.usage, end.spend),
    ...(run !== undefined
      ? {
          lastRun: {
            runId: run.runId,
            finishedAt: now.toISOString(),
            outcome: end.outcome,
            ...(summary !== undefined ? { summary } : {}),
          },
        }
      : {}),
  };
  const failed = end.outcome !== "completed";
  const failures = failed ? (loop.consecutiveFailures ?? 0) + 1 : 0;
  const { consecutiveFailures: _previous, ...counted } = base;
  const next: LoopRecordInput =
    failures > 0 ? { ...counted, consecutiveFailures: failures } : counted;
  const scheduled = nextRunAfter(loop.schedule, now);

  if (run?.stopAfter === "cancel") {
    return { ...next, state: { kind: "canceled" } };
  }
  if (end.endRequested !== undefined) {
    return { ...next, state: { kind: "completed", reason: end.endRequested } };
  }
  if (loop.budget.expiresAt !== undefined && Date.parse(loop.budget.expiresAt) <= now.getTime()) {
    return { ...next, state: { kind: "completed", reason: "It reached its end time." } };
  }
  if (scheduled === undefined) {
    return { ...next, state: { kind: "failed", reason: "Its schedule no longer parses." } };
  }
  const withNext = { ...next, nextRunAt: scheduled.toISOString() };
  if (run?.stopAfter === "pause") {
    return { ...withNext, state: { kind: "paused" } };
  }
  const limit = loopLimitReached(withNext);
  if (limit === "runs") {
    return {
      ...withNext,
      state: {
        kind: "completed",
        reason: `It ran the ${String(loop.budget.maxRuns)} times it was allowed.`,
      },
    };
  }
  if (limit !== undefined) {
    return { ...withNext, state: { kind: "budget-limited", limit } };
  }
  if (failures >= MAX_CONSECUTIVE_LOOP_FAILURES) {
    return {
      ...withNext,
      state: {
        kind: "failed",
        reason: `Its last ${String(failures)} runs failed${base.lastRun?.summary !== undefined ? `, the latest with: ${base.lastRun.summary}` : ""}.`,
      },
    };
  }
  return { ...withNext, state: { kind: "active" } };
}

export type LoopControl = "pause" | "resume" | "cancel";

export type LoopControlDecision =
  | { readonly kind: "write"; readonly next: LoopRecordInput; readonly note?: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Raise every cap by one default budget beyond what the loop has used. */
function extendLoopBudget(loop: LoopRecord): LoopBudget {
  const { budget, usage } = loop;
  return {
    ...budget,
    ...(budget.maxRuns !== undefined
      ? { maxRuns: Math.max(budget.maxRuns, usage.runs + budget.maxRuns) }
      : {}),
    maxTokens: Math.max(budget.maxTokens, usage.totalTokens + DEFAULT_LOOP_BUDGET.maxTokens),
    maxDurationMs: Math.max(
      budget.maxDurationMs,
      usage.activeDurationMs + DEFAULT_LOOP_BUDGET.maxDurationMs,
    ),
    ...(budget.maxCostUSD !== undefined
      ? {
          maxCostUSD: Math.max(
            budget.maxCostUSD,
            (usage.costUSD ?? 0) + (DEFAULT_LOOP_BUDGET.maxCostUSD ?? 0),
          ),
        }
      : {}),
  };
}

export function decideLoopControl(
  loop: LoopRecord,
  control: LoopControl,
  now: Date,
): LoopControlDecision {
  const { state, run } = loop;
  if (state.kind === "completed" || state.kind === "canceled") {
    return { kind: "refused", reason: `The loop is ${state.kind} and can no longer change.` };
  }
  switch (control) {
    case "pause":
      if (state.kind !== "active") {
        return { kind: "refused", reason: `A ${state.kind} loop cannot be paused.` };
      }
      return run !== undefined
        ? {
            kind: "write",
            next: { ...withoutRun(loop), run: { ...run, stopAfter: "pause" } },
            note: "The run in flight finishes first.",
          }
        : { kind: "write", next: { ...withoutRun(loop), state: { kind: "paused" } } };
    case "cancel":
      return run !== undefined
        ? {
            kind: "write",
            next: { ...withoutRun(loop), run: { ...run, stopAfter: "cancel" } },
            note: "The run in flight finishes first; nothing runs after it.",
          }
        : { kind: "write", next: { ...withoutRun(loop), state: { kind: "canceled" } } };
    case "resume": {
      if (state.kind === "active") {
        return { kind: "refused", reason: "The loop is already running." };
      }
      const { consecutiveFailures: _cleared, ...resumed } = withoutRun(loop);
      const overdue = Date.parse(loop.nextRunAt) <= now.getTime();
      const next: LoopRecordInput = {
        ...resumed,
        state: { kind: "active" },
        ...(overdue ? { nextRunAt: now.toISOString() } : {}),
        ...(state.kind === "budget-limited" ? { budget: extendLoopBudget(loop) } : {}),
      };
      return state.kind === "budget-limited"
        ? { kind: "write", next, note: "The budget was extended by one default budget." }
        : { kind: "write", next };
    }
  }
}
