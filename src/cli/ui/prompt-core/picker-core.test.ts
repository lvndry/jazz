import { describe, expect, it } from "bun:test";
import {
  createPickerState,
  derivePickerView,
  filterAndRank,
  reducePicker,
  resolvePicker,
  type PickerChoice,
} from "./picker-core";

const CHOICES: readonly PickerChoice[] = [
  { label: "Alpha", value: "a", description: "first" },
  { label: "Beta", value: "b", description: "second", disabled: true },
  { label: "Gamma", value: "g", description: "third" },
  { label: "Delta", value: "d" },
];

describe("filterAndRank", () => {
  it("returns every choice when the query is empty, preserving order", () => {
    const ranked = filterAndRank(CHOICES, "");
    expect(ranked.map((r) => r.originalIndex)).toEqual([0, 1, 2, 3]);
  });

  it("ranks matches by label position, not just membership", () => {
    const ranked = filterAndRank(
      [
        { label: "Zeta model", value: "z" },
        { label: "Alpha model", value: "a" },
      ],
      "model",
    );
    // Both match at a word boundary; the tie-break is the lower match index,
    // so "Zeta model" (index 5) sorts before "Alpha model" (index 6).
    expect(ranked[0]?.originalIndex).toBe(0);
    expect(ranked[1]?.originalIndex).toBe(1);
  });

  it("reports the match offset inside the label", () => {
    const ranked = filterAndRank([{ label: "Alpha model", value: "a" }], "model");
    expect(ranked[0]?.matchIndex).toBe(6);
  });
});

describe("derivePickerView", () => {
  it("marks the cursor row active and carries the description", () => {
    const state = createPickerState({ type: "select", choices: CHOICES, initialCursor: 2 });
    const view = derivePickerView(state);
    expect(view.rows[2]?.active).toBe(true);
    expect(view.rows[0]?.active).toBe(false);
    expect(view.rows[2]?.description).toBe("third");
    expect(view.filteredCount).toBe(4);
  });

  it("reflects the checked set for multi-select", () => {
    const state = createPickerState({
      type: "checkbox",
      choices: CHOICES,
      allowMultiple: true,
      defaultChecked: [0, 2],
    });
    const view = derivePickerView(state);
    expect(view.rows[0]?.selected).toBe(true);
    expect(view.rows[1]?.selected).toBe(false);
    expect(view.rows[2]?.selected).toBe(true);
  });
});

describe("reducePicker", () => {
  it("resets the cursor when the query changes", () => {
    const state = createPickerState({ type: "search", choices: CHOICES, initialCursor: 3 });
    const next = reducePicker(state, { kind: "setQuery", query: "a" });
    expect(next.query).toBe("a");
    expect(next.cursor).toBe(0);
  });

  it("skips disabled rows when moving", () => {
    const state = createPickerState({ type: "select", choices: CHOICES, initialCursor: 0 });
    // From Alpha (0) moving down should land on Gamma (2), skipping Beta (1, disabled).
    const next = reducePicker(state, { kind: "move", delta: 1 });
    expect(next.cursor).toBe(2);
  });

  it("toggles the checked set on toggle for multi-select", () => {
    const state = createPickerState({
      type: "checkbox",
      choices: CHOICES,
      allowMultiple: true,
      initialCursor: 2,
    });
    const toggled = reducePicker(state, { kind: "toggle" });
    expect(toggled.checked.has(2)).toBe(true);
    const untoggled = reducePicker(toggled, { kind: "toggle" });
    expect(untoggled.checked.has(2)).toBe(false);
  });

  it("ignores toggle outside multi-select", () => {
    const state = createPickerState({ type: "select", choices: CHOICES, initialCursor: 0 });
    expect(reducePicker(state, { kind: "toggle" })).toBe(state);
  });

  it("jumps to a valid quick-pick index and ignores disabled/out-of-range", () => {
    const state = createPickerState({ type: "select", choices: CHOICES });
    expect(reducePicker(state, { kind: "quickPick", index: 2 }).cursor).toBe(2);
    expect(reducePicker(state, { kind: "quickPick", index: 99 }).cursor).toBe(0);
  });
});

describe("resolvePicker", () => {
  it("resolves the active single choice", () => {
    const state = createPickerState({ type: "select", choices: CHOICES, initialCursor: 2 });
    expect(resolvePicker(state)).toEqual({ kind: "single", value: "g" });
  });

  it("resolves all checked values for multi-select, in original order", () => {
    const state = createPickerState({
      type: "checkbox",
      choices: CHOICES,
      allowMultiple: true,
      defaultChecked: [2, 0],
    });
    expect(resolvePicker(state)).toEqual({ kind: "multi", values: ["a", "g"] });
  });

  it("falls back to the custom value when allowed and nothing is active", () => {
    const state = createPickerState({
      type: "select",
      choices: CHOICES,
      allowCustom: true,
      customValue: "typed",
      // A query that matches nothing leaves no active row to resolve.
      query: "zzz-no-match",
    });
    expect(resolvePicker(state)).toEqual({ kind: "custom", value: "typed" });
  });

  it("resolves none when there is nothing to select", () => {
    const state = createPickerState({ type: "select", choices: CHOICES, initialCursor: 1 });
    // Cursor on a disabled row with no custom fallback.
    expect(resolvePicker(state).kind).toBe("none");
  });
});
