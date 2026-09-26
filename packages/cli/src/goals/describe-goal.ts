/**
 * @fileoverview How the chat `/goal` command and the `jazz goal` CLI show a goal and its plan:
 * one block per goal, in plain words, ending with what the user can do next on that surface.
 */

import { pendingGoalInput } from "@jazz/adapters/goals/goal-actions";
import type { GoalPlan, GoalRecord } from "@jazz/core/agent/goal/goal-record";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { formatCompactCount } from "@jazz/core/utils/string";
import { Effect } from "effect";

/** Where a goal is shown, which decides how its next commands are spelled. */
export type GoalSurface = "chat" | "cli";

/** Characters of a goal id shown in listings; any unique prefix is accepted back. */
const SHORT_ID_CHARS = 8;

export function shortGoalId(goalId: string): string {
  return goalId.slice(0, SHORT_ID_CHARS);
}

/** What people call a goal: its name, or the start of its id for a goal made before names. */
export function goalHandle(goal: Pick<GoalRecord, "goalId" | "name">): string {
  return goal.name ?? shortGoalId(goal.goalId);
}

/** What the goal is waiting on when it waits for the user (see `pendingGoalInput`). */
export interface PendingGoalInput {
  readonly kind: "tool-approval" | "question" | "file-picker";
  readonly described: string;
}

/** The goal's state as a person would say it. */
export function goalStatus(goal: GoalRecord, pending?: PendingGoalInput): string {
  const { state } = goal;
  switch (state.kind) {
    case "proposed":
      return "proposed, waiting for you to accept it";
    case "active":
      return goal.cycle !== undefined ? `working (cycle ${String(goal.usage.cycles)})` : "working";
    case "awaiting-input":
      return pending?.kind === "question" || state.reason === "question"
        ? "waiting for your answer"
        : "waiting for your approval";
    case "paused":
      return "paused";
    case "stopping":
      return "stopping after the current cycle";
    case "review-required":
      return state.question !== undefined
        ? "has a question for you"
        : `stopped for your review: ${state.reason}`;
    case "budget-limited":
      return `out of budget (${state.limit})`;
    case "completed":
      return `completed: ${state.summary}`;
    case "failed":
      return `failed: ${state.error}`;
    case "canceled":
      return "canceled";
  }
}

/** The commands that move the goal on from where it is, spelled for the surface. */
export function nextGoalCommands(
  goal: GoalRecord,
  surface: GoalSurface,
  pending?: PendingGoalInput,
): string[] {
  const command = surface === "chat" ? "/goal" : "jazz goal";
  const id = goalHandle(goal);
  switch (goal.state.kind) {
    case "proposed":
      return [`${command} accept ${id}`, `${command} decline ${id}`];
    case "active":
      return [`${command} pause ${id}`, `${command} cancel ${id}`];
    case "awaiting-input":
      return pending?.kind === "question" || goal.state.reason === "question"
        ? [`${command} answer ${id} <your answer>`]
        : [`${command} approve ${id}`, `${command} reject ${id} [why]`];
    case "paused":
      return [`${command} resume ${id} [note]`, `${command} cancel ${id}`];
    case "review-required":
      return goal.state.question !== undefined
        ? [`${command} resume ${id} <your answer>`]
        : [`${command} resume ${id} [note]`, `${command} cancel ${id}`];
    case "budget-limited":
      return [`${command} resume ${id} (adds one default budget)`, `${command} cancel ${id}`];
    default:
      return [];
  }
}

const UNATTENDED_GRANTS: Record<ApprovalPolicyLevel, string> = {
  "read-only": "read only",
  "low-risk": "read and make low-risk changes",
  "high-risk": "run anything, including commands flagged high-risk",
};

/** One goal as a block: status, objective, progress, what it waits on, and what to do next. */
export function describeGoal(
  goal: GoalRecord,
  surface: GoalSurface,
  pending?: PendingGoalInput,
): string {
  const done = goal.plan.steps.filter((step) => step.state === "completed").length;
  const next = nextGoalCommands(goal, surface, pending);
  const lines = [
    `Goal ${goalHandle(goal)} · ${goalStatus(goal, pending)}`,
    `  ${goal.plan.objective}`,
    `  Progress: step ${String(done)} of ${String(goal.plan.steps.length)} · cycle ${String(goal.usage.cycles)} of ${String(goal.budget.maxCycles)} · ${formatCompactCount(goal.usage.totalTokens)} of ${formatCompactCount(goal.budget.maxTokens)} tokens · ${String(Math.round(goal.usage.activeDurationMs / 60_000))} of ${String(Math.round(goal.budget.maxDurationMs / 60_000))} min`,
    ...(goal.approvalPolicy !== undefined
      ? [`  In the background it may, without asking: ${UNATTENDED_GRANTS[goal.approvalPolicy]}`]
      : []),
    ...(pending !== undefined ? [`  Waiting on: ${pending.described}`] : []),
    ...(goal.state.kind === "review-required" && goal.state.question !== undefined
      ? [`  Question: ${goal.state.question}`]
      : []),
    ...(goal.lastProgress !== undefined
      ? [`  Last: ${goal.lastProgress.split("\n").join(" ")}`]
      : []),
    ...(next.length > 0 ? [`  Next: ${next.join("  ·  ")}`] : []),
  ];
  return lines.join("\n");
}

function section(title: string, items: readonly string[], numbered = false): string[] {
  if (items.length === 0) {
    return [];
  }
  return [
    "",
    title,
    ...items.map((item, index) => (numbered ? `  ${String(index + 1)}. ${item}` : `  • ${item}`)),
  ];
}

export function describePlan(plan: GoalPlan): string {
  return [
    plan.objective,
    "",
    `Feasibility: ${plan.feasibility.assessment}. ${plan.feasibility.rationale}`,
    ...section("Done when", plan.successCriteria),
    ...section(
      "Steps",
      plan.steps.map((step) => step.objective),
      true,
    ),
    ...section("Constraints", plan.constraints),
    ...section("Assumptions", plan.assumptions),
  ].join("\n");
}

/** `describeGoal`, with what a waiting goal is waiting on looked up from its run. */
export function describeGoalNow(goal: GoalRecord, surface: GoalSurface) {
  return Effect.map(pendingGoalInput(goal), (pending) => describeGoal(goal, surface, pending));
}
