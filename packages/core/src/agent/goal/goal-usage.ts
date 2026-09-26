/**
 * @fileoverview Aggregate goal budgets: what a cycle may still spend, and folding a finished
 * run's spend into the goal.
 *
 * Usage only grows. A run's spend is folded in once, when its cycle is reconciled, and cost
 * stays unknown for the rest of the goal once any run had no pricing.
 */

import { addRunSpend, type RunSpend } from "@/core/agent/run/run-spend";
import type { GoalBudget, GoalLimit, GoalRecord, GoalUsage } from "./goal-record";

/**
 * Every model call resends the conversation, so tokens grow with iterations rather than with
 * output: a single call with the default persona and tool set costs tens of thousands of
 * prompt tokens before the task adds anything. The token cap is sized for a dozen cycles of
 * that; the dollar cap is what stops a priced provider, and only binds when pricing is known.
 */
export const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxCycles: 12,
  maxTokens: 5_000_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxCostUSD: 5,
};

export function addSpend(usage: GoalUsage, spend: RunSpend): GoalUsage {
  return addRunSpend(usage, spend);
}

/** The first cap the goal has reached, or undefined while it may start another cycle. */
export function reachedLimit(goal: Pick<GoalRecord, "budget" | "usage">): GoalLimit | undefined {
  const { budget, usage } = goal;
  if (usage.cycles >= budget.maxCycles) {
    return "cycles";
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

export interface CycleCaps {
  readonly maxTokens: number;
  readonly maxDurationMs: number;
  readonly maxCostUSD?: number;
}

/**
 * The caps for the next stretch of a cycle: what the goal has left after `inFlight`, the
 * spend of a parked run that is about to resume. A cap at or below zero is a reached limit.
 */
export function remainingCaps(
  goal: Pick<GoalRecord, "budget" | "usage">,
  inFlight: RunSpend = { totalTokens: 0, activeDurationMs: 0 },
):
  | { readonly kind: "caps"; readonly caps: CycleCaps }
  | { readonly kind: "limit"; readonly limit: GoalLimit } {
  const tokens = goal.budget.maxTokens - goal.usage.totalTokens - inFlight.totalTokens;
  if (tokens <= 0) {
    return { kind: "limit", limit: "tokens" };
  }
  const duration =
    goal.budget.maxDurationMs - goal.usage.activeDurationMs - inFlight.activeDurationMs;
  if (duration <= 0) {
    return { kind: "limit", limit: "duration" };
  }
  let maxCostUSD: number | undefined;
  if (goal.budget.maxCostUSD !== undefined && goal.usage.costKnown) {
    maxCostUSD = goal.budget.maxCostUSD - (goal.usage.costUSD ?? 0) - (inFlight.costUSD ?? 0);
    if (maxCostUSD <= 0) {
      return { kind: "limit", limit: "cost" };
    }
  }
  return {
    kind: "caps",
    caps: {
      maxTokens: tokens,
      maxDurationMs: duration,
      ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
    },
  };
}

/**
 * Raise every cap so the goal has one default budget's worth of room beyond what it has used.
 * This is the explicit budget change a budget-limited goal waits for.
 */
export function extendBudget(goal: Pick<GoalRecord, "budget" | "usage">): GoalBudget {
  const { budget, usage } = goal;
  const maxCostUSD =
    budget.maxCostUSD === undefined
      ? undefined
      : Math.max(budget.maxCostUSD, (usage.costUSD ?? 0) + (DEFAULT_GOAL_BUDGET.maxCostUSD ?? 0));
  return {
    maxCycles: Math.max(budget.maxCycles, usage.cycles + DEFAULT_GOAL_BUDGET.maxCycles),
    maxTokens: Math.max(budget.maxTokens, usage.totalTokens + DEFAULT_GOAL_BUDGET.maxTokens),
    maxDurationMs: Math.max(
      budget.maxDurationMs,
      usage.activeDurationMs + DEFAULT_GOAL_BUDGET.maxDurationMs,
    ),
    ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
    ...(budget.maxIterationsPerCycle !== undefined
      ? { maxIterationsPerCycle: budget.maxIterationsPerCycle }
      : {}),
  };
}
