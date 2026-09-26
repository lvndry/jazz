/**
 * @fileoverview Lifecycle states for a durable goal.
 *
 * A goal outlives any one AgentRunner invocation. Its state records what the Jazz
 * controller knows about the user's objective, while individual runs record what happened
 * during one attempt. A final answer from a run is therefore not, by itself, a completed
 * goal.
 */

import type { GoalLimit } from "./goal-record";

export type GoalState =
  | { readonly kind: "proposed" }
  /** Eligible for a cycle; one is running exactly when the record has an open `cycle`. */
  | { readonly kind: "active" }
  | { readonly kind: "awaiting-input"; readonly reason: "question" | "approval" }
  | { readonly kind: "paused" }
  | { readonly kind: "stopping" }
  | { readonly kind: "budget-limited"; readonly limit: GoalLimit }
  | {
      readonly kind: "review-required";
      readonly reason: string;
      /** Set when the goal stopped to ask the user something; resuming with a note answers it. */
      readonly question?: string;
    }
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "canceled" };

export type GoalStateKind = GoalState["kind"];

const TERMINAL_KINDS = new Set<GoalStateKind>(["completed", "failed", "canceled"]);

export function isTerminalGoal(state: GoalState): boolean {
  return TERMINAL_KINDS.has(state.kind);
}

/** States in which a goal holds its cycle claim, and with it its conversation's one active slot. */
export const CLAIMED_GOAL_STATES = [
  "active",
  "awaiting-input",
  "stopping",
] as const satisfies readonly GoalStateKind[];

const CLAIMED_KINDS = new Set<GoalStateKind>(CLAIMED_GOAL_STATES);

export function isGoalClaimed(state: GoalState): boolean {
  return CLAIMED_KINDS.has(state.kind);
}

const ALLOWED_TRANSITIONS: Readonly<Record<GoalStateKind, readonly GoalStateKind[]>> = {
  proposed: ["active", "canceled"],
  active: [
    "awaiting-input",
    "paused",
    "stopping",
    "budget-limited",
    "review-required",
    "completed",
    "failed",
    "canceled",
  ],
  "awaiting-input": [
    "active",
    "paused",
    "stopping",
    "budget-limited",
    "review-required",
    "completed",
    "failed",
  ],
  paused: [
    "active",
    "awaiting-input",
    "stopping",
    "budget-limited",
    "review-required",
    "completed",
    "canceled",
  ],
  stopping: ["paused", "canceled", "completed", "review-required", "failed"],
  "budget-limited": ["active", "paused", "canceled"],
  "review-required": ["active", "paused", "canceled", "failed"],
  completed: [],
  failed: [],
  canceled: [],
};

export function canTransitionGoal(from: GoalStateKind, to: GoalStateKind): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidGoalTransitionError extends Error {
  constructor(
    readonly from: GoalStateKind,
    readonly to: GoalStateKind,
  ) {
    super(`A goal cannot move from "${from}" to "${to}".`);
    this.name = "InvalidGoalTransitionError";
  }
}

export function transitionGoal(from: GoalState, to: GoalState): GoalState {
  if (!canTransitionGoal(from.kind, to.kind)) {
    throw new InvalidGoalTransitionError(from.kind, to.kind);
  }
  return to;
}
