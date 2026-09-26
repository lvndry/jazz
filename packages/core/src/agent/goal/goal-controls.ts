/**
 * @fileoverview What a user control does to a goal: accept, pause, resume, cancel.
 *
 * Pure decisions over the goal and its latest run, shared by every surface that exposes the
 * controls, so the chat command and the daemon API cannot drift. A control that arrives while
 * a cycle is in flight is recorded on the cycle and applied when it settles; it never
 * interrupts a working run.
 */

import type { RunState } from "@/core/agent/run/run-state";
import type { ApprovalPolicyLevel } from "@/core/types/tools";
import { settleCycle } from "./goal-reconcile";
import { asInput, withoutCycle, type GoalRecord, type GoalRecordInput } from "./goal-record";
import { extendBudget, reachedLimit, remainingCaps, runSpend, type RunSpend } from "./goal-usage";

export type GoalControl = "pause" | "resume" | "cancel";

export type ControlDecision =
  | { readonly kind: "write"; readonly next: GoalRecordInput; readonly note?: string }
  | { readonly kind: "refused"; readonly reason: string };

/** The latest run as the controls see it; undefined when the goal has none or it was pruned. */
export interface LatestRun {
  readonly state: RunState;
  readonly spend: RunSpend;
}

export function latestRunView(
  run: { readonly state: RunState } & Parameters<typeof runSpend>[0],
): LatestRun {
  return { state: run.state, spend: runSpend(run) };
}

function write(next: GoalRecordInput, note?: string): ControlDecision {
  return note === undefined ? { kind: "write", next } : { kind: "write", next, note };
}

function refuse(reason: string): ControlDecision {
  return { kind: "refused", reason };
}

/**
 * Accept a proposed plan. The approval policy is the authority the user grants with the
 * acceptance; without one the goal's cycles run only read-only and low-risk tools unasked.
 */
export function decideAccept(
  goal: GoalRecord,
  planRevision: number,
  approvalPolicy?: ApprovalPolicyLevel,
): ControlDecision {
  if (goal.state.kind !== "proposed" || planRevision !== goal.plan.revision) {
    return refuse("The proposal is stale or no longer awaiting acceptance.");
  }
  return write({
    ...asInput(goal),
    state: { kind: "active" },
    approvedPlanRevision: goal.plan.revision,
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
  });
}

export function decidePause(goal: GoalRecord): ControlDecision {
  const { state, cycle } = goal;
  if (state.kind === "active" && cycle !== undefined) {
    return write(
      { ...asInput(goal), state: { kind: "stopping" }, cycle: { ...cycle, stopAfter: "pause" } },
      "The running cycle will finish first.",
    );
  }
  if (
    state.kind === "active" ||
    state.kind === "awaiting-input" ||
    state.kind === "budget-limited" ||
    state.kind === "review-required"
  ) {
    return write({ ...asInput(goal), state: { kind: "paused" } });
  }
  return refuse(`A ${state.kind} goal cannot be paused.`);
}

function withGuidance(goal: GoalRecordInput, guidance: string | undefined): GoalRecordInput {
  const trimmed = guidance?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return goal;
  }
  const progress = goal.lastProgress === undefined ? "" : `${goal.lastProgress}\n`;
  return { ...goal, lastProgress: `${progress}User guidance: ${trimmed}` };
}

/**
 * Resume a paused, review-required, or budget-limited goal. `guidance` is the user's answer
 * or direction for the next cycle. Resuming a budget-limited goal is the explicit budget
 * change it waits for: every cap gains one default budget of room.
 */
export function decideResume(
  goal: GoalRecord,
  latestRun: LatestRun | undefined,
  guidance?: string,
): ControlDecision {
  const { state, cycle } = goal;
  if (state.kind === "paused" && cycle !== undefined) {
    const run = latestRun?.state;
    if (run?.kind === "input-required") {
      const reason = run.pending.kind === "tool-approval" ? "approval" : "question";
      const waiting: GoalRecordInput = {
        ...asInput(goal),
        state: { kind: "awaiting-input", reason },
      };
      if (remainingCaps(goal, latestRun?.spend).kind === "limit") {
        return write(
          { ...waiting, budget: extendBudget(goal, latestRun?.spend) },
          "The budget ran out while the run waited; it was extended by one default budget.",
        );
      }
      return write(waiting);
    }
    if (run?.kind === "working" || run?.kind === "submitted") {
      return write({ ...asInput(goal), state: { kind: "active" } });
    }
    const settled = settleCycle(goal, {
      run:
        latestRun === undefined
          ? { kind: "missing" }
          : run?.kind === "failed"
            ? { kind: "failed", error: run.error, spend: latestRun.spend }
            : run?.kind === "completed"
              ? { kind: "completed", spend: latestRun.spend }
              : { kind: "canceled", spend: latestRun.spend },
      unchecked: "The cycle's run ended while the goal was paused, so its outcome was not checked.",
    });
    return write(settled, "The paused cycle's run had already ended; review it before continuing.");
  }
  if (state.kind === "paused" || state.kind === "review-required") {
    const resumed = withGuidance({ ...withoutCycle(goal), state: { kind: "active" } }, guidance);
    if (reachedLimit(resumed) !== undefined) {
      return write(
        { ...resumed, budget: extendBudget(goal) },
        "The goal had used its budget; resuming extended it by one default budget.",
      );
    }
    return write(resumed);
  }
  if (state.kind === "budget-limited") {
    return write(
      withGuidance(
        { ...withoutCycle(goal), budget: extendBudget(goal), state: { kind: "active" } },
        guidance,
      ),
      "The budget was extended by one default budget.",
    );
  }
  return refuse(`A ${state.kind} goal cannot be resumed.`);
}

/**
 * Cancel a goal. With a cycle open the cancel is recorded on it; a parked run is then
 * canceled by the caller, and a working run settles first. Cancellation never undoes an
 * action that already happened.
 */
export function decideCancel(goal: GoalRecord): ControlDecision {
  const { state, cycle } = goal;
  if (
    cycle !== undefined &&
    (state.kind === "active" ||
      state.kind === "awaiting-input" ||
      state.kind === "paused" ||
      state.kind === "stopping")
  ) {
    return write({
      ...asInput(goal),
      state: { kind: "stopping" },
      cycle: { ...cycle, stopAfter: "cancel" },
    });
  }
  if (
    state.kind === "proposed" ||
    state.kind === "active" ||
    state.kind === "paused" ||
    state.kind === "budget-limited" ||
    state.kind === "review-required"
  ) {
    return write({ ...withoutCycle(goal), state: { kind: "canceled" } });
  }
  return refuse(`A ${state.kind} goal cannot be canceled.`);
}

export function decideControl(
  goal: GoalRecord,
  control: GoalControl,
  latestRun: LatestRun | undefined,
  guidance?: string,
): ControlDecision {
  switch (control) {
    case "pause":
      return decidePause(goal);
    case "resume":
      return decideResume(goal, latestRun, guidance);
    case "cancel":
      return decideCancel(goal);
  }
}
