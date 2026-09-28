import {
  STEP_SEPARATOR,
  TALLY_GAP,
  stepText,
  stepperView,
  type PromptStepPosition,
  type StepState,
} from "../../prompt-core/stepper";
import { THEME } from "../../theme";
import { terminalCellWidth } from "../terminal-cells";

export type QuestionStep = PromptStepPosition;

export interface StepperSegment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}

function stateColor(state: StepState): string {
  return state === "current" ? THEME.primary : THEME.muted;
}

/** The shared stepper, painted: done and upcoming steps muted, the current one bold in the accent. */
export function stepperSegments(
  step: QuestionStep,
  width: number,
  check: string,
): readonly StepperSegment[] {
  const view = stepperView(step, width, check);
  const trail: StepperSegment[] = view.items.flatMap((item, index) => [
    ...(index > 0 ? [{ text: STEP_SEPARATOR, fg: THEME.border }] : []),
    {
      text: stepText(item, check),
      fg: stateColor(item.state),
      ...(item.state === "current" ? { bold: true } : {}),
    },
  ]);
  const trailWidth = trail.reduce((total, part) => total + terminalCellWidth(part.text), 0);
  const gap = Math.max(TALLY_GAP, width - trailWidth - terminalCellWidth(view.tally));
  return [
    ...trail,
    { text: " ".repeat(gap), fg: THEME.muted },
    { text: view.tally, fg: THEME.muted },
  ];
}
