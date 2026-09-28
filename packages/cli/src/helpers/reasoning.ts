/**
 * Terminal-facing helpers for Jazz's model-neutral reasoning selection.
 *
 * Pickers offer the levels the model's resolved control accepts, falling back
 * to Jazz's whole portable vocabulary when the control is unknown. The
 * selection itself is the persisted effort string; its provider-native request
 * shape remains private to the capability registry.
 */

import { type PromptStep, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  CAPABILITY_REASONING_EFFORTS,
  clampReasoningSelection,
  type ReasoningControlSurface,
  type ReasoningSelection,
} from "@jazz/core/types/model-capabilities";
import { Effect } from "effect";

/** A resolved control, or `unknown` when Jazz cannot tell which levels the model accepts. */
export type ResolvedReasoningControl = ReasoningControlSurface | { readonly kind: "unknown" };

/** The effort a toggle-only model is saved with when it is switched on. */
const TOGGLE_ON_EFFORT = "medium";

export const CLI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CliReasoningValue = (typeof CLI_REASONING_EFFORTS)[number] | "disable";

export function isCliReasoningValue(value: string): value is CliReasoningValue {
  return value === "disable" || (CLI_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function reasoningSelectionFromCliValue(value: CliReasoningValue): ReasoningSelection {
  return value;
}

export function reasoningSelectionToCliValue(
  selection: ReasoningSelection | undefined,
): CliReasoningValue {
  return selection ?? "disable";
}

export function formatReasoningSelection(selection: ReasoningSelection | undefined): string {
  return selection ?? "disabled";
}

/** The effort to show beside the model, or nothing when the conversation does not reason. */
export function reasoningEffortLabel(
  selection: ReasoningSelection | undefined,
): string | undefined {
  return selection === undefined || selection === "disable" ? undefined : selection;
}

/**
 * The levels a picker should offer for this control, weakest first, `disable` last.
 *
 * A toggle-only model offers a single "on" level, keeping the current effort when there
 * is one, because every enabled effort sends the same request. A model that cannot stop
 * reasoning never offers `disable`, and one that does not reason offers only `disable`.
 */
export function reasoningChoicesFor(
  control: ResolvedReasoningControl | undefined,
  current?: ReasoningSelection,
): readonly CliReasoningValue[] {
  if (!control || control.kind === "unknown") {
    return [...CLI_REASONING_EFFORTS, "disable"];
  }
  if (control.kind === "unsupported") {
    return ["disable"];
  }
  const disable: readonly CliReasoningValue[] = control.canDisableReasoning ? ["disable"] : [];
  if (control.kind === "toggle") {
    const on = current && current !== "disable" ? current : TOGGLE_ON_EFFORT;
    return [on, ...disable];
  }
  const listed = "efforts" in control ? control.efforts : undefined;
  const efforts =
    listed !== undefined && listed.length > 0
      ? CAPABILITY_REASONING_EFFORTS.filter((effort) => listed.includes(effort))
      : CAPABILITY_REASONING_EFFORTS;
  return [...efforts, ...disable];
}

/**
 * A one-line note when the model runs `selection` as a different level, or undefined when
 * it runs as asked. Pickers only offer accepted levels, but a saved agent or a typed
 * `/reasoning` value can predate the model it now runs on.
 */
export function describeReasoningAdjustment(
  selection: ReasoningSelection | undefined,
  control: ResolvedReasoningControl | undefined,
): string | undefined {
  const effective = clampReasoningSelection(selection, control);
  if (effective === selection || effective === undefined) {
    return undefined;
  }
  if (selection === "disable") {
    return control?.kind === "toggle"
      ? "this model cannot turn reasoning off; reasoning stays on"
      : `this model cannot turn reasoning off; it runs at ${effective}`;
  }
  return `this model does not support ${selection}; it runs at ${effective}`;
}

/** A reasoning level as a picker row: the level, and the one trade-off it makes. */
function reasoningChoice(
  value: CliReasoningValue,
  toggle: boolean,
): { readonly name: string; readonly description: string } {
  if (toggle) {
    return value === "disable"
      ? { name: "off", description: "answers straight away, fastest" }
      : { name: "on", description: "thinks before answering" };
  }
  switch (value) {
    case "minimal":
      return { name: "minimal", description: "the least thinking the model supports" };
    case "low":
      return { name: "low", description: "quick answers, light thinking" };
    case "medium":
      return {
        name: "medium",
        description: "thinks before multi-step work, stays quick on simple questions",
      };
    case "high":
      return { name: "high", description: "deep thinking, slower and costlier" };
    case "xhigh":
      return { name: "extra high", description: "deeper still, noticeably slower" };
    case "max":
      return { name: "max", description: "the provider's deepest thinking, slowest" };
    case "disable":
      return { name: "off", description: "no thinking, fastest" };
  }
}

/** The level a picker should start on: the current selection as the model would run it. */
export function defaultReasoningChoice(
  choices: readonly CliReasoningValue[],
  current: ReasoningSelection | undefined,
  control: ResolvedReasoningControl | undefined,
): CliReasoningValue {
  const effective = clampReasoningSelection(current, control);
  if (effective !== undefined && effective !== "disable" && choices.includes(effective)) {
    return effective;
  }
  if (choices.includes(TOGGLE_ON_EFFORT)) {
    return TOGGLE_ON_EFFORT;
  }
  return choices.find((choice) => choice !== "disable") ?? "disable";
}

export async function promptForReasoningSelection(
  terminal: TerminalService,
  current: ReasoningSelection | undefined,
  options: {
    readonly prompt?: string;
    readonly control?: ResolvedReasoningControl | undefined;
    readonly step?: PromptStep;
  } = {},
): Promise<ReasoningSelection | undefined> {
  const choices = reasoningChoicesFor(options.control, current);
  const toggle = options.control?.kind === "toggle";
  const recommended = choices.includes(TOGGLE_ON_EFFORT) ? TOGGLE_ON_EFFORT : undefined;
  const selected = await Effect.runPromise(
    terminal.select<CliReasoningValue>(options.prompt ?? "How hard should it think?", {
      choices: choices.map((value) => ({
        ...reasoningChoice(value, toggle),
        value,
        ...(value === recommended && !toggle
          ? { tag: "recommended", tagTone: "accent" as const }
          : {}),
      })),
      default: defaultReasoningChoice(choices, current, options.control),
      ...(options.step === undefined ? {} : { step: options.step }),
    }),
  );
  return selected === undefined ? undefined : reasoningSelectionFromCliValue(selected);
}
