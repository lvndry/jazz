/**
 * @fileoverview Deleting a choice from a picker: ctrl+d asks about the highlighted row, Enter
 * deletes it, Esc keeps it. A deleted row leaves the list and the picker stays open.
 *
 * Pure, like `picker-core`, so the Ink and fullscreen pickers share one rule for what each key
 * does, what the hint row says, and when a row is gone. The renderers only map their key events
 * to these intents and run the deletion the prompt was given.
 */

import { toError } from "@jazz/core/utils/errors";
import { Effect } from "effect";

export type RemovalStatus =
  | { readonly phase: "idle"; readonly error?: string }
  | { readonly phase: "confirming"; readonly value: unknown; readonly label: string }
  | { readonly phase: "removing"; readonly value: unknown; readonly label: string };

export interface ChoiceRemovalState {
  readonly status: RemovalStatus;
  /** Values deleted while the picker was open; their rows are left out. */
  readonly removed: readonly unknown[];
}

export const INITIAL_CHOICE_REMOVAL: ChoiceRemovalState = {
  status: { phase: "idle" },
  removed: [],
};

export type ChoiceRemovalIntent =
  | { readonly kind: "ask"; readonly value: unknown; readonly label: string }
  | { readonly kind: "keep" }
  | { readonly kind: "start" }
  | { readonly kind: "removed"; readonly value: unknown }
  | { readonly kind: "failed"; readonly message: string };

/** Longest row label a confirmation quotes; the hint row has one line. */
const MAX_CONFIRM_LABEL_CHARS = 48;

function clipLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_CONFIRM_LABEL_CHARS
    ? flat
    : `${flat.slice(0, MAX_CONFIRM_LABEL_CHARS - 1)}…`;
}

export function reduceChoiceRemoval(
  state: ChoiceRemovalState,
  intent: ChoiceRemovalIntent,
): ChoiceRemovalState {
  const { status } = state;
  switch (intent.kind) {
    case "ask":
      return status.phase === "removing"
        ? state
        : {
            ...state,
            status: { phase: "confirming", value: intent.value, label: clipLabel(intent.label) },
          };
    case "keep":
      return status.phase === "confirming" ? { ...state, status: { phase: "idle" } } : state;
    case "start":
      return status.phase === "confirming"
        ? { ...state, status: { ...status, phase: "removing" } }
        : state;
    case "removed":
      return { status: { phase: "idle" }, removed: [...state.removed, intent.value] };
    case "failed":
      return { ...state, status: { phase: "idle", error: intent.message } };
  }
}

/** The choices still in the list. */
export function withoutRemoved<Choice extends { readonly value: unknown }>(
  choices: readonly Choice[],
  state: ChoiceRemovalState,
): readonly Choice[] {
  if (state.removed.length === 0) {
    return choices;
  }
  return choices.filter((choice) => !state.removed.some((value) => Object.is(value, choice.value)));
}

/** Whether a key press is the ctrl+d that asks to delete the highlighted row. */
export function isRemovalKey(key: { readonly name?: string; readonly ctrl?: boolean }): boolean {
  return key.ctrl === true && key.name === "d";
}

export interface RemovalHintKey {
  readonly key: string;
  readonly label: string;
}

/** The key that starts a deletion, listed with the picker's other keys while nothing is pending. */
export const REMOVAL_HINT: RemovalHintKey = { key: "ctrl+d", label: "delete" };

/** The keys to show instead of the picker's own while a deletion is pending, if one is. */
export function pendingRemovalHints(
  state: ChoiceRemovalState,
): readonly RemovalHintKey[] | undefined {
  switch (state.status.phase) {
    case "confirming":
      return [
        { key: "enter", label: `delete "${state.status.label}"` },
        { key: "esc", label: "keep it" },
      ];
    case "removing":
      return [{ key: "", label: `deleting "${state.status.label}"…` }];
    case "idle":
      return undefined;
  }
}

/** Why the last deletion did not happen, until the next one is asked for. */
export function removalError(state: ChoiceRemovalState): string | undefined {
  return state.status.phase === "idle" ? state.status.error : undefined;
}

/** Run the pending deletion and report how it went, as the intent to dispatch next. */
export async function runRemoval(
  remove: (value: unknown) => Effect.Effect<void, Error>,
  value: unknown,
): Promise<ChoiceRemovalIntent> {
  const outcome = await Effect.runPromise(
    remove(value).pipe(
      Effect.catchDefect((defect) => Effect.fail(toError(defect))),
      Effect.result,
    ),
  );
  return outcome._tag === "Success"
    ? { kind: "removed", value }
    : { kind: "failed", message: outcome.failure.message };
}
