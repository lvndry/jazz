/**
 * @fileoverview Shared interaction core for choice-based prompts.
 *
 * Every interactive picker in Jazz — `select`, `search`, `checkbox`,
 * `questionnaire` and the `confirm` variant — behaves the same way underneath:
 * a list of choices, an optional filter query, a cursor, an optional checked
 * set, and a resolution step. Until now that behaviour was implemented twice,
 * once for the ink (standard) renderer and once for the OpenTUI (fullscreen)
 * renderer, which is how the two modes drifted apart (fullscreen filtered
 * without ranking while standard ranked; standard dropped the description
 * line that fullscreen painted).
 *
 * This module is the single source of that behaviour. It is pure — no React,
 * no ink, no `@opentui` import — so both renderers can drive it from key
 * events and paint the `PickerView` it derives. Renderers keep only their
 * visual layout (card vs free list, alignment, colours), which is the part
 * that is supposed to differ between hosts.
 *
 * The contract that prevents drift: a renderer must produce its rows from
 * `derivePickerView`, and must move state through `reducePicker`. Any future
 * change to filtering, ranking, cursor, selection or resolution touches one
 * function here, not two components.
 */

import { rankPickerMatches } from "../picker-window";

/** A single choice as the core sees it. Hosts map their domain choices to this. */
export interface PickerChoice {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export type PickerType = "select" | "search" | "checkbox" | "questionnaire";

/** All mutable interaction state for a choice-based prompt. */
export interface PickerState {
  readonly type: PickerType;
  readonly choices: readonly PickerChoice[];
  /** Incremental filter text (empty means "show all"). */
  readonly query: string;
  /** Cursor index into the *filtered* list, not the original choices. */
  readonly cursor: number;
  /** Original-choice indices that are checked (checkbox / multi-select). */
  readonly checked: ReadonlySet<number>;
  /** Questionnaire / checkbox multi-select mode. */
  readonly allowMultiple?: boolean;
  /** A free-text row the user can type into when nothing matches. */
  readonly allowCustom?: boolean;
  /** The free-text value, when `allowCustom` is set. */
  readonly customValue?: string;
  /** Original-choice indices checked by default. */
  readonly defaultChecked?: readonly number[];
}

/** Options for {@link createPickerState}. Optional fields accept `undefined`
 *  explicitly so callers can forward `maybeDefined ?? undefined` under
 *  `exactOptionalPropertyTypes`. */
export interface CreatePickerStateOptions {
  readonly type: PickerType;
  readonly choices: readonly PickerChoice[];
  readonly query?: string | undefined;
  readonly allowMultiple?: boolean | undefined;
  readonly allowCustom?: boolean | undefined;
  readonly customValue?: string | undefined;
  readonly defaultChecked?: readonly number[] | undefined;
  readonly initialCursor?: number | undefined;
}

/** A choice paired with its position in the original list, after filtering/ranking. */
export interface RankedChoice {
  readonly originalIndex: number;
  readonly choice: PickerChoice;
  /** Offset of the query match inside the label, or -1 when there is no query. */
  readonly matchIndex: number;
}

/**
 * Filter and rank `choices` against `query`.
 *
 * Shares `rankPickerMatches` with the rest of the UI so the ranking order is
 * identical everywhere — this is the function that ended the fullscreen-vs-
 * standard ranking divergence. Returns original indices so cursors and checked
 * sets stay stable across re-filtering.
 */
export function filterAndRank(
  choices: readonly PickerChoice[],
  query: string,
): readonly RankedChoice[] {
  const ranked = rankPickerMatches(choices, query);
  return ranked.map((entry) => ({
    // Original array index, not the filtered position: callers map a ranked
    // choice back to its source via this index.
    originalIndex: choices.indexOf(entry.item),
    choice: entry.item,
    matchIndex: entry.matchIndex,
  }));
}

/** Build the initial picker state from prompt data. */
export function createPickerState(options: CreatePickerStateOptions): PickerState {
  const checked = new Set<number>(options.defaultChecked ?? []);
  return {
    type: options.type,
    choices: options.choices,
    query: options.query ?? "",
    cursor: options.initialCursor ?? 0,
    checked,
    allowMultiple: options.allowMultiple ?? false,
    allowCustom: options.allowCustom ?? false,
    customValue: options.customValue ?? "",
    defaultChecked: options.defaultChecked ?? [],
  };
}

/** A row the renderer paints — derived, never stored. */
export interface PickerRow {
  readonly originalIndex: number;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly active: boolean;
  readonly selected: boolean;
  /** Offset of the active query inside the label, or -1 when there is no query. */
  readonly matchIndex: number;
}

/** The complete derived view for a picker at its current state. */
export interface PickerView {
  readonly rows: readonly PickerRow[];
  readonly totalCount: number;
  readonly filteredCount: number;
  readonly cursor: number;
  readonly query: string;
  readonly checked: ReadonlySet<number>;
}

/**
 * Derive the paint-ready view from state. Renderers window this (both already
 * window by height/width) but the *content* — order, labels, descriptions,
 * which row is active, which are checked — is single-sourced here.
 */
export function derivePickerView(state: PickerState): PickerView {
  const ranked = filterAndRank(state.choices, state.query);
  const rows: PickerRow[] = ranked.map((entry, index) => ({
    originalIndex: entry.originalIndex,
    label: entry.choice.label,
    ...(entry.choice.description === undefined ? {} : { description: entry.choice.description }),
    disabled: entry.choice.disabled === true,
    active: index === state.cursor,
    selected: state.checked.has(entry.originalIndex),
    matchIndex: entry.matchIndex,
  }));
  return {
    rows,
    totalCount: state.choices.length,
    filteredCount: ranked.length,
    cursor: state.cursor,
    query: state.query,
    checked: state.checked,
  };
}

/** Intent the drivers feed in. Host-agnostic: ink keys and OpenTUI actions both map to these. */
export type PickerIntent =
  | { readonly kind: "setQuery"; readonly query: string }
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "first" }
  | { readonly kind: "last" }
  | { readonly kind: "toggle" }
  | { readonly kind: "quickPick"; readonly index: number }
  | { readonly kind: "submit" };

function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor));
}

/**
 * Move the cursor by `delta` through the filtered list, skipping disabled rows.
 * Skipping mirrors the standard `ScrollableSelect` rule and keeps disabled
 * choices unselectable without special-casing in the renderer.
 */
function moveCursor(filtered: readonly RankedChoice[], cursor: number, delta: number): number {
  if (filtered.length === 0) return 0;
  const direction = delta > 0 ? 1 : -1;
  let next = cursor;
  for (let step = 0; step < filtered.length; step += 1) {
    next = clampCursor(next + direction, filtered.length);
    if (!filtered[next]?.choice.disabled) return next;
  }
  return cursor;
}

/**
 * Pure state transition. The renderer calls this on every key intent and
 * repaints from `derivePickerView`. Resolution (what value a submit yields) is
 * a separate pure step, `resolvePicker`, so drivers and tests can inspect the
 * outcome without a renderer.
 */
export function reducePicker(state: PickerState, intent: PickerIntent): PickerState {
  const filtered = filterAndRank(state.choices, state.query);

  switch (intent.kind) {
    case "setQuery": {
      return { ...state, query: intent.query, cursor: 0 };
    }
    case "move": {
      return { ...state, cursor: moveCursor(filtered, state.cursor, intent.delta) };
    }
    case "first": {
      return { ...state, cursor: moveCursor(filtered, -1, filtered.length) };
    }
    case "last": {
      return { ...state, cursor: moveCursor(filtered, filtered.length, filtered.length) };
    }
    case "toggle": {
      if (state.type !== "checkbox" && state.type !== "questionnaire") return state;
      if (!state.allowMultiple) return state;
      const current = filtered[state.cursor];
      if (current === undefined) return state;
      const next = new Set(state.checked);
      if (next.has(current.originalIndex)) next.delete(current.originalIndex);
      else next.add(current.originalIndex);
      return { ...state, checked: next };
    }
    case "quickPick": {
      const target = intent.index;
      if (target < 0 || target >= filtered.length) return state;
      if (filtered[target]?.choice.disabled) return state;
      return { ...state, cursor: target };
    }
    case "submit": {
      return state;
    }
  }
}

export type PickerResolution =
  | { readonly kind: "single"; readonly value: string }
  | { readonly kind: "multi"; readonly values: readonly string[] }
  | { readonly kind: "custom"; readonly value: string }
  | { readonly kind: "none" };

/**
 * What a submit produces, derived purely from state. Hosts call this when the
 * user confirms, so the "what gets resolved" rule lives here too.
 */
export function resolvePicker(state: PickerState): PickerResolution {
  const filtered = filterAndRank(state.choices, state.query);

  if (state.type === "checkbox" || (state.type === "questionnaire" && state.allowMultiple)) {
    const values = [...state.checked]
      .sort((left, right) => left - right)
      .map((index) => state.choices[index]?.value)
      .filter((value): value is string => value !== undefined);
    return { kind: "multi", values };
  }

  const current = filtered[state.cursor];
  if (current !== undefined && !current.choice.disabled) {
    return { kind: "single", value: current.choice.value };
  }

  if (state.allowCustom && (state.customValue ?? "").length > 0) {
    return { kind: "custom", value: state.customValue ?? "" };
  }

  return { kind: "none" };
}
