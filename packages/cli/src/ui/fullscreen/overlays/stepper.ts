import { THEME } from "../../theme";
import { terminalCellWidth } from "../terminal-cells";

/** Where a prompt sits in a multi-step flow: every step's label, and which one this is. */
export interface QuestionStep {
  readonly labels: readonly string[];
  readonly index: number;
}

export interface StepperSegment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}

/** Spaces kept between the step trail and the tally. */
const TALLY_GAP = 2;

/**
 * The stepper row: done steps muted with a check, the current step bold in the accent, the rest
 * muted, and "N of M" flush right. When the whole trail does not fit, the current step and the
 * tally are what stay.
 */
export function stepperSegments(
  step: QuestionStep,
  width: number,
  check: string,
): readonly StepperSegment[] {
  const tally = `${String(step.index + 1)} of ${String(step.labels.length)}`;
  const full: StepperSegment[] = step.labels.flatMap((label, index) => {
    const parts: StepperSegment[] = [];
    if (index > 0) parts.push({ text: " › ", fg: THEME.border });
    if (index < step.index) parts.push({ text: `${check} ${label}`, fg: THEME.muted });
    else if (index === step.index) parts.push({ text: label, fg: THEME.primary, bold: true });
    else parts.push({ text: label, fg: THEME.muted });
    return parts;
  });
  const widthOf = (parts: readonly StepperSegment[]): number =>
    parts.reduce((total, part) => total + terminalCellWidth(part.text), 0);
  const trail: readonly StepperSegment[] =
    widthOf(full) + TALLY_GAP + terminalCellWidth(tally) <= width
      ? full
      : [{ text: step.labels[step.index] ?? "", fg: THEME.primary, bold: true }];
  const gap = Math.max(TALLY_GAP, width - widthOf(trail) - terminalCellWidth(tally));
  return [...trail, { text: " ".repeat(gap), fg: THEME.muted }, { text: tally, fg: THEME.muted }];
}
