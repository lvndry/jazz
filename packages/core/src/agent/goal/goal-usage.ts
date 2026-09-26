/**
 * @fileoverview Aggregate goal budgets: what a cycle may still spend, and folding a finished
 * run's spend into the goal.
 *
 * Usage only grows. A run's spend is folded in once, when its cycle is reconciled, and cost
 * stays unknown for the rest of the goal once any run had no pricing.
 */

import {
  addRunSpend,
  extendSpendBudget,
  remainingSpendCaps,
  spendLimitReached,
  type RunSpend,
} from "@/core/agent/run/run-spend";
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
  return goal.usage.cycles >= goal.budget.maxCycles
    ? "cycles"
    : spendLimitReached(goal.budget, goal.usage);
}

/**
 * The caps for the next stretch of a cycle: what the goal has left after `inFlight`, the
 * spend of a parked run that is about to resume. A cap at or below zero is a reached limit.
 */
export function remainingCaps(goal: Pick<GoalRecord, "budget" | "usage">, inFlight?: RunSpend) {
  return remainingSpendCaps(goal.budget, goal.usage, inFlight);
}

/**
 * Raise every cap so the goal has one default budget's worth of room beyond what it has used,
 * counting a parked run's spend that is not folded into the goal yet: extending from recorded
 * usage alone would leave that run still over the cap. This is the explicit budget change a
 * budget-limited goal waits for.
 */
export function extendBudget(
  goal: Pick<GoalRecord, "budget" | "usage">,
  inFlight?: RunSpend,
): GoalBudget {
  const { budget, usage } = goal;
  return {
    maxCycles: Math.max(budget.maxCycles, usage.cycles + DEFAULT_GOAL_BUDGET.maxCycles),
    ...extendSpendBudget(budget, usage, DEFAULT_GOAL_BUDGET, inFlight),
    ...(budget.maxIterationsPerCycle !== undefined
      ? { maxIterationsPerCycle: budget.maxIterationsPerCycle }
      : {}),
  };
}
