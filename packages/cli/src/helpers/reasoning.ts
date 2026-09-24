/**
 * Terminal-facing helpers for Jazz's model-neutral reasoning selection.
 *
 * Until a provider's resolved control surface is available to the CLI, the
 * wizard and chat command expose Jazz's portable effort vocabulary. The
 * selection itself is the persisted effort string; its provider-native request
 * shape remains private to the capability registry.
 */

import { type TerminalService } from "@jazz/core/interfaces/terminal";
import type { ReasoningSelection } from "@jazz/core/types/model-capabilities";
import { Effect } from "effect";

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

function choiceName(value: CliReasoningValue): string {
  switch (value) {
    case "minimal":
      return "Minimal - Fastest supported reasoning";
    case "low":
      return "Low - Faster responses, basic reasoning";
    case "medium":
      return "Medium - Balanced speed and reasoning depth (recommended)";
    case "high":
      return "High - Deep reasoning, slower responses";
    case "xhigh":
      return "Extra high - Maximum reasoning depth, slower responses";
    case "max":
      return "Max - Provider maximum reasoning depth, slowest responses";
    case "disable":
      return "Disable - No reasoning (fastest)";
  }
}

export async function promptForReasoningSelection(
  terminal: TerminalService,
  current: ReasoningSelection | undefined,
  prompt = "What reasoning effort level would you like?",
): Promise<ReasoningSelection | undefined> {
  const selected = await Effect.runPromise(
    terminal.select<CliReasoningValue>(prompt, {
      choices: ([...CLI_REASONING_EFFORTS, "disable"] as readonly CliReasoningValue[]).map(
        (value) => ({
          name: choiceName(value),
          value,
        }),
      ),
      default: current && current !== "disable" ? current : "medium",
    }),
  );
  return selected === undefined ? undefined : reasoningSelectionFromCliValue(selected);
}
