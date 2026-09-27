/**
 * @fileoverview What a loop does next: when it is due, claiming a run, folding a finished run
 * in, and the user's controls. Pure functions over the record, shared by the daemon and every
 * surface that controls loops.
 */

import {
  addRunSpend,
  extendSpendBudget,
  remainingSpendCaps,
  spendLimitReached,
  type RunSpend,
} from "@/core/agent/run/run-spend";
import { END_LOOP_TOOL_NAME } from "@/core/agent/tools/loop";
import { lastSucceededToolCall, type ToolCallMessage } from "@/core/agent/tools/tool-call-history";
import { isValidCronExpression, nextCronRun } from "@/core/utils/cron";
import type { ProcessOwner } from "@/core/utils/process";
import { parseDurationMs } from "@/core/utils/time";
import {
  DEFAULT_LOOP_BUDGET,
  MAX_CONSECUTIVE_LOOP_FAILURES,
  MIN_LOOP_INTERVAL_MS,
  withoutRun,
  type LoopBudget,
  type LoopLastRun,
  type LoopLimit,
  type LoopRecord,
  type LoopRecordInput,
  type LoopSchedule,
  type LoopState,
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

/**
 * When a new loop first runs: an interval loop right away, a cron loop at its first scheduled
 * time, so `0 9 * * mon` started on a Thursday waits for Monday.
 */
export function firstRunAt(schedule: LoopSchedule, now: Date): Date | undefined {
  return schedule.kind === "every" ? now : nextRunAfter(schedule, now);
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
  return budget.maxRuns !== undefined && usage.runs >= budget.maxRuns
    ? "runs"
    : spendLimitReached(budget, usage);
}

/**
 * What one run may still spend, from what the loop has left after `inFlight`, the spend of a
 * parked run about to resume that is not folded into the loop yet.
 */
export function loopRunCaps(loop: Pick<LoopRecord, "budget" | "usage">, inFlight?: RunSpend) {
  return remainingSpendCaps(loop.budget, loop.usage, inFlight);
}

/**
 * The state a loop takes once `limit` is reached: its run limit ends it for good, a spend cap
 * waits for the user to extend the budget.
 */
function limitState(loop: Pick<LoopRecord, "budget">, limit: LoopLimit): LoopState {
  return limit === "runs"
    ? {
        kind: "completed",
        reason: `It ran the ${String(loop.budget.maxRuns)} times it was allowed.`,
      }
    : { kind: "budget-limited", limit };
}

/**
 * The loop stopped at a cap it reached while no run was in flight, such as a budget lowered by
 * hand; undefined while it may start another run.
 */
export function stopAtLimit(loop: LoopRecord): LoopRecordInput | undefined {
  const limit = loopLimitReached(loop);
  return limit === undefined ? undefined : { ...withoutRun(loop), state: limitState(loop, limit) };
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
  if (limit !== undefined) {
    return { ...withNext, state: limitState(loop, limit) };
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
    ...extendSpendBudget(budget, usage, DEFAULT_LOOP_BUDGET),
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
            note: "The run in progress finishes first; if it is waiting on you, it is dropped instead.",
          }
        : { kind: "write", next: { ...withoutRun(loop), state: { kind: "paused" } } };
    case "cancel":
      return run !== undefined
        ? {
            kind: "write",
            next: { ...withoutRun(loop), run: { ...run, stopAfter: "cancel" } },
            note: "The run in progress finishes first, or is dropped if it is waiting on you; nothing runs after it.",
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

function describeSchedule(schedule: LoopSchedule): string {
  if (schedule.kind === "cron") {
    return `on the schedule \`${schedule.expression}\`${schedule.timezone !== undefined ? ` (${schedule.timezone})` : ""}`;
  }
  const minutes = Math.round(schedule.everyMs / 60_000);
  return minutes % 60 === 0 ? `every ${String(minutes / 60)}h` : `every ${String(minutes)}m`;
}

/** The input for one run: the loop's prompt with what the run needs to know about the loop. */
export function loopRunPrompt(loop: LoopRecord): string {
  return [
    `This is run ${String(loop.usage.runs)} of a loop that runs ${describeSchedule(loop.schedule)}. The user is not watching.`,
    ...(loop.lastRun?.summary !== undefined
      ? [`The previous run (${loop.lastRun.outcome}) ended with: ${loop.lastRun.summary}`]
      : []),
    "When the loop's purpose is met, or it can no longer make progress, call end_loop with the reason so it stops; otherwise do this run's work and report briefly.",
    "",
    loop.prompt,
  ].join("\n");
}

/** The reason a run asked to end its loop: the last `end_loop` call that succeeded. */
export function endLoopRequest(messages: readonly ToolCallMessage[]): string | undefined {
  const call = lastSucceededToolCall(messages, END_LOOP_TOOL_NAME);
  if (call === undefined) {
    return undefined;
  }
  try {
    const reason = (JSON.parse(call) as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A schedule from what a person typed: a duration ("10m", "1h30m", "every 2h") or a cron
 * expression ("*\/15 9-17 * * mon-fri"). An interval under the minimum is refused, not rounded.
 */
export function parseLoopSchedule(
  spec: string,
  timezone?: string,
):
  | { readonly ok: true; readonly schedule: LoopSchedule }
  | { readonly ok: false; readonly reason: string } {
  const trimmed = spec.trim().replace(/^every\s+/i, "");
  const everyMs = parseDurationMs(trimmed);
  if (everyMs !== null) {
    return everyMs < MIN_LOOP_INTERVAL_MS
      ? { ok: false, reason: `A loop runs at most once a minute; "${spec}" is shorter.` }
      : { ok: true, schedule: { kind: "every", everyMs } };
  }
  if (isValidCronExpression(trimmed)) {
    return {
      ok: true,
      schedule: {
        kind: "cron",
        expression: trimmed,
        ...(timezone !== undefined ? { timezone } : {}),
      },
    };
  }
  return {
    ok: false,
    reason: `"${spec}" is neither a duration like 10m or 1h30m nor a cron expression.`,
  };
}
