/**
 * @fileoverview The rule that keeps a goal from stopping as blocked on a first impression.
 *
 * A cycle that reports `blocked` is often one approach away from getting past it. The goal
 * stops for review after matching blocker rounds, or a bounded run of blocked reports.
 */

import type { GoalRecord } from "./goal-record";

/** Consecutive cycles that must report the same blocker before the goal stops as blocked. */
export const BLOCKED_ROUNDS_REQUIRED = 3;

/**
 * Consecutive blocked reports, whatever blockers they name, after which the goal stops as
 * blocked anyway. Twice the rounds needed to be convinced: a goal that has been blocked that
 * long while its blocker keeps getting renamed is not getting unblocked.
 */
export const MAX_CONSECUTIVE_BLOCKED_REPORTS = BLOCKED_ROUNDS_REQUIRED * 2;

/** Case and punctuation are insignificant; word order and repeated words retain meaning. */
export function blockerKey(blocker: string): string {
  const words = blocker.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length === 0 ? blocker.trim() : words.join(" ");
}

/** Which consecutive round reporting `blocker` is, given the rounds the goal already recorded. */
export function blockerRound(goal: GoalRecord, blocker: string): number {
  const streak = goal.blockerStreak;
  return streak !== undefined && blockerKey(streak.blocker) === blocker ? streak.rounds + 1 : 1;
}

/** How many consecutive blocked reports this one makes, whichever blockers they named. */
export function blockedReportCount(goal: GoalRecord): number {
  const streak = goal.blockerStreak;
  return streak === undefined ? 1 : (streak.reports ?? streak.rounds) + 1;
}

/** Whether a blocked report, with the rounds and reports it makes, stops the goal as blocked. */
export function blockedStopsGoal(round: number, reports: number): boolean {
  return round >= BLOCKED_ROUNDS_REQUIRED || reports >= MAX_CONSECUTIVE_BLOCKED_REPORTS;
}

/** What a cycle is told when its blocked report is not yet enough to stop the goal. */
export function blockedRuleInstruction(blocker: string, round: number): string {
  return `Blocker "${blocker}" is recorded as round ${round} of ${BLOCKED_ROUNDS_REQUIRED}. Keep working: try a different approach to get past it. The goal stops as blocked once ${BLOCKED_ROUNDS_REQUIRED} consecutive cycles report the same blocker, or ${MAX_CONSECUTIVE_BLOCKED_REPORTS} blocked reports regardless of wording; so if it still stands, report blocked again with this same blocker text.`;
}
