/** Deterministic outcome metrics for memory and skill learning evals. */

export type LessonOutcome = "helped" | "failed" | "missed" | "noop";

export function classifyLessonOutcome(input: {
  readonly recalled: boolean;
  readonly triggerFired: boolean;
}): LessonOutcome {
  if (input.recalled && input.triggerFired) return "failed";
  if (!input.recalled && input.triggerFired) return "missed";
  if (input.recalled && !input.triggerFired) return "helped";
  return "noop";
}

export function outcomeRate(
  outcomes: readonly LessonOutcome[],
  target: Exclude<LessonOutcome, "noop">,
): number {
  const relevant = outcomes.filter((outcome) => outcome !== "noop");
  if (relevant.length === 0) return 0;
  return relevant.filter((outcome) => outcome === target).length / relevant.length;
}
