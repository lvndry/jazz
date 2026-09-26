/**
 * @fileoverview Folding an ended cycle into its goal.
 *
 * Every way a cycle can end — its run finished, failed, was canceled, was cut off by the
 * process stopping, or died while the goal was paused — goes through {@link settleCycle}, so the run's spend is added exactly once and
 * the open cycle is closed in the same write. What the goal becomes follows one precedence:
 * a verified completion wins, then a stop the user asked for, then a budget cap, then the
 * disposition's own next step.
 */

import type { RunSpend } from "@/core/agent/run/run-spend";
import type { GoalEvaluationResult } from "./goal-evaluation";
import { withoutCycle, type GoalLimit, type GoalRecord, type GoalRecordInput } from "./goal-record";
import { addSpend, reachedLimit } from "./goal-usage";

export type EndedRun =
  | { readonly kind: "completed"; readonly spend: RunSpend }
  | { readonly kind: "failed"; readonly error: string; readonly spend: RunSpend }
  | { readonly kind: "canceled"; readonly spend: RunSpend }
  /** The process running the cycle stopped before its run finished. */
  | { readonly kind: "interrupted"; readonly spend: RunSpend }
  /** No durable record: the claim was written but the run never recorded anything. */
  | { readonly kind: "missing" };

export interface CycleEnd {
  readonly run: EndedRun;
  /** The validated disposition; only a completed run has one. */
  readonly evaluation?: GoalEvaluationResult;
  /** A run-level cap the cycle hit, which leaves the goal budget-limited. */
  readonly cappedBy?: Exclude<GoalLimit, "cycles">;
  /** The cycle's outcome was not checked at all; it goes straight to review with this reason. */
  readonly unchecked?: string;
}

/**
 * Completion claims that may fail their evidence check in a row before the goal stops for
 * review. A weak model often does the work but quotes badly on the first try; told what was
 * missing, it usually produces the output on the next cycle. Unlimited retries would let a
 * goal loop on a claim it cannot support.
 */
const MAX_UNVERIFIED_CLAIMS = 2;

/**
 * Cycles in a row that may be cut off by the process stopping before the goal stops for
 * review. A restart is not the agent's failure, so an unattended goal carries on; a cycle
 * that keeps dying (a crash it triggers itself) needs a person.
 */
const MAX_INTERRUPTED_CYCLES = 2;

const INTERRUPTED_NOTE =
  "The previous cycle was cut off when the process running it stopped, so some of its actions may have happened and others not. Check the current state before redoing anything.";

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

  if (end.unchecked !== undefined && stopAfter !== "cancel") {
    return review(base, end.unchecked);
  }
  if (end.run.kind === "interrupted" && stopAfter === "pause") {
    return {
      ...base,
      lastProgress: base.lastProgress ?? INTERRUPTED_NOTE,
      state: { kind: "paused" },
    };
  }
  if (end.run.kind === "interrupted" && stopAfter === undefined) {
    const interrupted = (goal.interruptedCycles ?? 0) + 1;
    if (interrupted > MAX_INTERRUPTED_CYCLES) {
      return review(
        base,
        "The process running this goal stopped during several cycles in a row; check for side effects before continuing.",
      );
    }
    const limit = reachedLimit(base);
    return {
      ...base,
      interruptedCycles: interrupted,
      lastProgress:
        base.lastProgress === undefined
          ? INTERRUPTED_NOTE
          : `${base.lastProgress}\n${INTERRUPTED_NOTE}`,
      state: limit === undefined ? { kind: "active" } : { kind: "budget-limited", limit },
    };
  }
  if (end.run.kind !== "completed") {
    if (stopAfter === "cancel") {
      return { ...base, state: { kind: "canceled" } };
    }
    const reason =
      end.run.kind === "missing"
        ? "The cycle's run left no record; check for side effects before continuing."
        : end.run.kind === "failed"
          ? `The cycle's run failed (${end.run.error}); check for side effects before continuing.`
          : end.run.kind === "interrupted"
            ? "The process running the cycle stopped; check for side effects before continuing."
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

  const {
    unverifiedClaims: _previousClaims,
    interruptedCycles: _previousInterruptions,
    ...settledBase
  } = base;
  const progressed =
    evaluation?.kind === "valid" && evaluation.evaluation.status === "continue"
      ? {
          ...settledBase,
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
      : evaluation?.kind === "invalid"
        ? {
            ...settledBase,
            ...(base.unverifiedClaims !== undefined
              ? { unverifiedClaims: base.unverifiedClaims }
              : {}),
          }
        : settledBase;

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
    const claims = (goal.unverifiedClaims ?? 0) + 1;
    if (claims > MAX_UNVERIFIED_CLAIMS) {
      return review(progressed, evaluation.reason);
    }
    const limit = reachedLimit(progressed);
    const feedback = `The last cycle's report was not accepted: ${evaluation.reason} Produce tool output that shows each remaining criterion holds, then report again.`;
    return {
      ...progressed,
      unverifiedClaims: claims,
      lastProgress:
        progressed.lastProgress === undefined
          ? feedback
          : `${progressed.lastProgress}\n${feedback}`,
      state: limit === undefined ? { kind: "active" } : { kind: "budget-limited", limit },
    };
  }
  switch (evaluation.evaluation.status) {
    case "blocked":
      return {
        ...review(progressed, evaluation.evaluation.summary),
        lastProgress: evaluation.evaluation.summary,
      };
    case "question":
      return {
        ...progressed,
        lastProgress:
          progressed.lastProgress === undefined
            ? `Asked the user: ${evaluation.evaluation.question}`
            : `${progressed.lastProgress}\nAsked the user: ${evaluation.evaluation.question}`,
        state: {
          kind: "review-required",
          reason: "Jazz needs your input.",
          question: evaluation.evaluation.question,
        },
      };
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
