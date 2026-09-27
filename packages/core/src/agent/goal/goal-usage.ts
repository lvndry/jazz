/**
 * @fileoverview Aggregate goal budgets: what a cycle may still spend, and folding a finished
 * run's spend into the goal.
 *
 * Usage only grows. A run's spend is folded in once, when its cycle is reconciled, and cost
 * stays unknown for the rest of the goal once any run had no pricing.
 */

import { addRunSpend, type RunSpend } from "@/core/agent/run/run-spend";
import type { GoalBudget, GoalLimit, GoalRecord, GoalUsage } from "./goal-record";

/** A goal has no cap beyond its runs' own until one is asked for. */
export const DEFAULT_GOAL_BUDGET: GoalBudget = {};

export function addSpend(usage: GoalUsage, spend: RunSpend): GoalUsage {
  return addRunSpend(usage, spend);
}

/** The cap the goal has reached, or undefined while it may start another cycle. */
export function reachedLimit(goal: Pick<GoalRecord, "budget" | "usage">): GoalLimit | undefined {
  return goal.budget.maxCycles !== undefined && goal.usage.cycles >= goal.budget.maxCycles
    ? "cycles"
    : undefined;
}

/**
 * Give a goal at its cycle cap as many cycles again: the explicit budget change a
 * budget-limited goal waits for.
 */
export function extendBudget(goal: Pick<GoalRecord, "budget" | "usage">): GoalBudget {
  const { budget, usage } = goal;
  return budget.maxCycles === undefined
    ? budget
    : { maxCycles: Math.max(budget.maxCycles, usage.cycles + budget.maxCycles) };
}
