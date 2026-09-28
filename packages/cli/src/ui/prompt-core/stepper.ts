/**
 * Where a prompt sits in a multi-step flow, as data both renderers paint: each step's label and
 * whether it is done, current or still to come, and the "N of M" tally. No colour lives here;
 * the fullscreen overlay and the Ink prompt each map the states to their own styling.
 */

import { terminalCellWidth } from "../fullscreen/terminal-cells";

export interface PromptStepPosition {
  readonly labels: readonly string[];
  readonly index: number;
}

export type StepState = "done" | "current" | "todo";

export interface StepperItem {
  readonly label: string;
  readonly state: StepState;
}

export interface StepperView {
  readonly items: readonly StepperItem[];
  readonly tally: string;
}

/** What sits between two steps. */
export const STEP_SEPARATOR = " › ";

/** Spaces kept between the step trail and the tally. */
export const TALLY_GAP = 2;

/**
 * The stepper for `step`. When `width` is given and the whole trail would not fit beside the
 * tally, only the current step is kept, since it and the tally are what the reader needs.
 */
export function stepperView(step: PromptStepPosition, width?: number, doneMark = ""): StepperView {
  const tally = `${String(step.index + 1)} of ${String(step.labels.length)}`;
  const items: StepperItem[] = step.labels.map((label, index) => ({
    label,
    state: index < step.index ? "done" : index === step.index ? "current" : "todo",
  }));
  if (width === undefined) {
    return { items, tally };
  }
  const trailWidth = items.reduce(
    (total, item, index) =>
      total +
      (index > 0 ? terminalCellWidth(STEP_SEPARATOR) : 0) +
      terminalCellWidth(stepText(item, doneMark)),
    0,
  );
  const fits = trailWidth + TALLY_GAP + terminalCellWidth(tally) <= width;
  return fits
    ? { items, tally }
    : { items: items.filter((item) => item.state === "current"), tally };
}

/** A step's text: done steps carry the mark in front, when the renderer has one. */
export function stepText(item: StepperItem, doneMark: string): string {
  return item.state === "done" && doneMark.length > 0 ? `${doneMark} ${item.label}` : item.label;
}

/** A well-formed step position from untyped prompt options, or undefined. */
export function readPromptStep(value: unknown): PromptStepPosition | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { labels, index } = value as { labels?: unknown; index?: unknown };
  if (!Array.isArray(labels) || typeof index !== "number") {
    return undefined;
  }
  const names = labels.filter((label): label is string => typeof label === "string");
  return index >= 0 && index < names.length ? { labels: names, index } : undefined;
}
