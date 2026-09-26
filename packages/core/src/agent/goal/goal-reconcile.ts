/**
 * @fileoverview Folding an ended cycle into its goal.
 *
 * Every way a cycle can end — its run finished, failed, was canceled, or died while the goal
 * was paused — goes through {@link settleCycle}, so the run's spend is added exactly once and
 * the open cycle is closed in the same write. What the goal becomes follows one precedence:
 * a verified completion wins, then a stop the user asked for, then a budget cap, then the
 * disposition's own next step.
 */

import type { GoalEvaluationResult } from "./goal-evaluation";
import { withoutCycle, type GoalRecord, type GoalRecordInput } from "./goal-record";
import { addSpend, reachedLimit, type GoalLimit, type RunSpend } from "./goal-usage";

export type EndedRun =
  | { readonly kind: "completed"; readonly spend: RunSpend }
  | { readonly kind: "failed"; readonly error: string; readonly spend: RunSpend }
  | { readonly kind: "canceled"; readonly spend: RunSpend }
  /** No durable record: the claim was written but the run never recorded anything. */
  | { readonly kind: "missing" };

export interface CycleEnd {
  readonly run: EndedRun;
  /** The validated disposition; only a completed run has one. */
  readonly evaluation?: GoalEvaluationResult;
  /** A run-level cap the cycle hit, which leaves the goal budget-limited. */
  readonly cappedBy?: Exclude<GoalLimit, "cycles">;
}

function review(base: GoalRecordInput, reason: string): GoalRecordInput {
  return { ...base, state: { kind: "review-required", reason } };
}

/** The next record for a goal whose open cycle has ended. */
export function settleCycle(goal: GoalRecord, end: CycleEnd): GoalRecordInput {
  const cycle = goal.cycle;
  if (cycle === undefined) {
    throw new Error(`Goal "${goal.goalId}" has no open cycle to settle.`);
  }
  const stopAfter = cycle.stopAfter;
  const usage = end.run.kind === "missing" ? goal.usage : addSpend(goal.usage, end.run.spend);
  const base: GoalRecordInput = { ...withoutCycle(goal), usage };

  if (end.run.kind !== "completed") {
    if (stopAfter === "cancel") {
      return { ...base, state: { kind: "canceled" } };
    }
    const reason =
      end.run.kind === "missing"
        ? "The cycle's run left no record; check for side effects before continuing."
        : end.run.kind === "failed"
          ? `The cycle's run failed (${end.run.error}); check for side effects before continuing.`
          : "The cycle's run was canceled; check for side effects before continuing.";
    return review(base, reason);
  }

  const evaluation = end.evaluation;
  if (evaluation?.kind === "valid" && evaluation.evaluation.status === "complete") {
    return {
      ...base,
      state: { kind: "completed", summary: evaluation.evaluation.summary },
      evidence: {
        runId: cycle.runId,
        planRevision: goal.plan.revision,
        items: evaluation.evaluation.evidence,
      },
      lastProgress: evaluation.evaluation.summary,
    };
  }

  const progressed =
    evaluation?.kind === "valid" && evaluation.evaluation.status === "continue"
      ? {
          ...base,
          plan: {
            ...goal.plan,
            steps: goal.plan.steps.map((step) =>
              evaluation.evaluation.status === "continue" &&
              evaluation.evaluation.completedStepIds.includes(step.id)
                ? { ...step, state: "completed" as const }
                : step,
            ),
          },
          lastProgress: `${evaluation.evaluation.summary}\nNext: ${evaluation.evaluation.nextAction}`,
        }
      : base;

  if (stopAfter === "cancel") {
    return { ...progressed, state: { kind: "canceled" } };
  }
  if (stopAfter === "pause") {
    return { ...progressed, state: { kind: "paused" } };
  }
  if (end.cappedBy !== undefined) {
    return { ...progressed, state: { kind: "budget-limited", limit: end.cappedBy } };
  }
  if (evaluation === undefined) {
    return review(progressed, "The cycle ended without a disposition to check.");
  }
  if (evaluation.kind === "invalid") {
    return review(progressed, evaluation.reason);
  }
  switch (evaluation.evaluation.status) {
    case "blocked":
      return {
        ...review(progressed, evaluation.evaluation.summary),
        lastProgress: evaluation.evaluation.summary,
      };
    case "question":
      return review(
        progressed,
        `Jazz needs your input: ${evaluation.evaluation.question} Answer with /goal resume ${goal.goalId} <answer>.`,
      );
    case "continue": {
      const limit = reachedLimit(progressed);
      return {
        ...progressed,
        state: limit === undefined ? { kind: "active" } : { kind: "budget-limited", limit },
      };
    }
  }
  return review(progressed, "The cycle's disposition could not be applied.");
}
