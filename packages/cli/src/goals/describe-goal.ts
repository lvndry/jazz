/**
 * @fileoverview How the chat `/goal` command and the `jazz goal` CLI show a goal and its plan.
 */

import type { GoalPlan, GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { formatCompactCount } from "@jazz/core/utils/string";

/** One goal as a listing shows it: state, step progress, spend against budget, and what is next. */
export function describeGoal(goal: GoalRecord): string[] {
  const done = goal.plan.steps.filter((step) => step.state === "completed").length;
  const state =
    goal.state.kind === "review-required"
      ? goal.state.question !== undefined
        ? `waiting for your answer: ${goal.state.question} (resume the goal with your answer as the note)`
        : `review-required: ${goal.state.reason}`
      : goal.state.kind === "budget-limited"
        ? `budget-limited (${goal.state.limit})`
        : goal.state.kind === "awaiting-input"
          ? `awaiting ${goal.state.reason}${goal.cycle !== undefined ? ` on run ${goal.cycle.runId}` : ""}`
          : goal.state.kind;
  const authority =
    goal.approvedPlanRevision === undefined
      ? ""
      : ` · runs unasked: ${goal.approvalPolicy ?? "read-only and low-risk tools"}`;
  return [
    `${goal.goalId}  ${goal.plan.objective}`,
    `  ${state}${authority}`,
    `  steps ${done}/${goal.plan.steps.length} · cycles ${goal.usage.cycles}/${goal.budget.maxCycles} · tokens ${formatCompactCount(goal.usage.totalTokens)}/${formatCompactCount(goal.budget.maxTokens)} · ${Math.round(goal.usage.activeDurationMs / 60_000)}/${Math.round(goal.budget.maxDurationMs / 60_000)} min`,
    ...(goal.lastProgress !== undefined
      ? [`  last: ${goal.lastProgress.split("\n").join(" · ")}`]
      : []),
  ];
}

export function describePlan(plan: GoalPlan): string {
  return [
    `Objective: ${plan.objective}`,
    `Feasibility: ${plan.feasibility.assessment} — ${plan.feasibility.rationale}`,
    "Success criteria:",
    ...plan.successCriteria.map((criterion) => `  • ${criterion}`),
    "Steps:",
    ...plan.steps.map((step, index) => `  ${index + 1}. ${step.objective}`),
    ...(plan.constraints.length > 0 ? [`Constraints: ${plan.constraints.join("; ")}`] : []),
    ...(plan.assumptions.length > 0 ? [`Assumptions: ${plan.assumptions.join("; ")}`] : []),
  ].join("\n");
}
