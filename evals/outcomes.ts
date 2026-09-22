/**
 * Outcome metrics for memory-learning evals. The classification is the store's
 * own rule, imported rather than restated, so an eval cannot score a run
 * differently from how the sidecar would credit it.
 */

import { classifyMemoryOutcome, type MemoryOutcomeKind } from "@/core/memory/lifecycle";

export type LessonOutcome = MemoryOutcomeKind;

export const classifyLessonOutcome = classifyMemoryOutcome;

export function outcomeRate(
  outcomes: readonly LessonOutcome[],
  target: Exclude<LessonOutcome, "noop">,
): number {
  const relevant = outcomes.filter((outcome) => outcome !== "noop");
  if (relevant.length === 0) return 0;
  return relevant.filter((outcome) => outcome === target).length / relevant.length;
}
