import { describe, expect, it } from "bun:test";
import {
  PICKER_WINDOW_SIZE,
  carouselWindow,
  pickerItemMatches,
  pickerWindow,
  pickerWindowStart,
  rankPickerMatches,
  wrapIndex,
} from "./picker-window";

const THIRTY = Array.from({ length: 30 }, (_, index) => `item-${String(index + 1)}`);

describe("wrapIndex", () => {
  it("wraps past both ends", () => {
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(0, 5)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(wrapIndex(3, 0)).toBe(0);
  });
});

describe("carouselWindow", () => {
  it("returns every item when the list fits", () => {
    expect(carouselWindow(["a", "b", "c"], 1, 10)).toEqual(["a", "b", "c"]);
  });

  it("keeps the selection at the end of a wrapping window", () => {
    const visible = carouselWindow(THIRTY, 0, PICKER_WINDOW_SIZE);
    expect(visible).toHaveLength(PICKER_WINDOW_SIZE);
    expect(visible.at(-1)).toBe("item-1");
    expect(visible[0]).toBe("item-22");
  });
});

describe("pickerWindow", () => {
  it("shows the first 10 items when the selection is at the top", () => {
    const visible = pickerWindow(THIRTY, 0, PICKER_WINDOW_SIZE);
    expect(visible).toEqual(THIRTY.slice(0, 10));
    expect(visible).not.toContain("item-11");
  });

  it("slides the window so a later selection stays on screen", () => {
    const visible = pickerWindow(THIRTY, 15, PICKER_WINDOW_SIZE);
    expect(visible).toHaveLength(PICKER_WINDOW_SIZE);
    expect(visible).toContain("item-16");
    expect(visible).not.toContain("item-1");
    expect(visible).not.toContain("item-6");
    expect(visible.at(-1)).toBe("item-16");
  });

  it("clamps the window at the end of the list", () => {
    const visible = pickerWindow(THIRTY, 29, PICKER_WINDOW_SIZE);
    expect(visible).toEqual(THIRTY.slice(20, 30));
  });

  it("returns an empty window for an empty list", () => {
    expect(pickerWindow([], 0, PICKER_WINDOW_SIZE)).toEqual([]);
  });
});

describe("pickerWindowStart", () => {
  it("stays at 0 until the selection walks off the first page", () => {
    expect(pickerWindowStart(0, 30, 10)).toBe(0);
    expect(pickerWindowStart(9, 30, 10)).toBe(0);
    expect(pickerWindowStart(10, 30, 10)).toBe(1);
  });
});

describe("pickerItemMatches", () => {
  const claude = {
    label: "Claude 3.5 Sonnet",
    value: "anthropic/claude-3.5-sonnet",
    description: "reasoning",
  };

  it("treats an empty query as a match for every item", () => {
    expect(pickerItemMatches(claude, "")).toBe(true);
    expect(pickerItemMatches(claude, "   ")).toBe(true);
  });

  it("matches label, id, and description", () => {
    expect(pickerItemMatches(claude, "sonnet")).toBe(true);
    expect(pickerItemMatches(claude, "anthropic")).toBe(true);
    expect(pickerItemMatches(claude, "REASON")).toBe(true);
  });

  it("rejects items that match nothing", () => {
    expect(pickerItemMatches(claude, "gemini")).toBe(false);
  });
});

describe("rankPickerMatches", () => {
  const choices = [
    { label: "OpenAI", value: "openai" },
    { label: "OpenRouter", value: "openrouter" },
    { label: "Anthropic", value: "anthropic" },
    { label: "Ollama", value: "ollama" },
  ];

  it("returns every item when the filter is empty", () => {
    const ranked = rankPickerMatches(choices, "");
    expect(ranked.map((entry) => entry.item.label)).toEqual(choices.map((choice) => choice.label));
    expect(ranked.every((entry) => entry.matchIndex === -1)).toBe(true);
  });

  it("filters incrementally and ranks a label prefix first", () => {
    const ranked = rankPickerMatches(choices, "open");
    expect(ranked.map((entry) => entry.item.label)).toEqual(["OpenAI", "OpenRouter"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(rankPickerMatches(choices, "zzz")).toEqual([]);
  });
});
