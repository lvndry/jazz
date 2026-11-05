/**
 * @fileoverview The rule that keeps a goal from stopping as blocked on a first impression.
 *
 * A cycle that reports `blocked` is often one approach away from getting past it. The goal
 * stops for review only once this many consecutive cycles have reported the same blocker.
 */

import type { GoalRecord } from "./goal-record";

/** Consecutive cycles that must report the same blocker before the goal stops as blocked. */
export const BLOCKED_ROUNDS_REQUIRED = 3;

/**
 * The identity a blocker is compared by: the reported blocker (or, when a disposition names
 * none, its summary) with case and spacing folded, so rewording in whitespace alone is not a
 * different blocker.
 */
export function blockerKey(report: {
  readonly summary: string;
  readonly blocker?: string | undefined;
}): string {
  return (report.blocker ?? report.summary).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Which consecutive round reporting `blocker` is, given the rounds the goal already recorded. */
export function blockerRound(goal: GoalRecord, blocker: string): number {
  return goal.blockerStreak?.blocker === blocker ? goal.blockerStreak.rounds + 1 : 1;
}

/** What a cycle is told when its blocked report is not yet enough to stop the goal. */
export function blockedRuleInstruction(blocker: string, round: number): string {
  return `Blocker "${blocker}" is recorded as round ${round} of ${BLOCKED_ROUNDS_REQUIRED}. Keep working: try a different approach to get past it. The goal stops as blocked once ${BLOCKED_ROUNDS_REQUIRED} consecutive cycles report the same blocker, so if it still stands, report blocked again with this same blocker text.`;
}
