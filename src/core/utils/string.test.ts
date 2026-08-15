import { describe, expect, test } from "bun:test";
import { buildLineOffsets, findAllOccurrenceLineNumbers, offsetToLine } from "./string";

describe("line offsets", () => {
  test("maps character offsets to one-based line numbers", () => {
    const offsets = buildLineOffsets("first\nsecond\nthird");
    expect(offsets).toEqual([0, 6, 13]);
    expect(offsetToLine(offsets, 0)).toBe(1);
    expect(offsetToLine(offsets, 6)).toBe(2);
    expect(offsetToLine(offsets, 18)).toBe(3);
  });

  test("reports every occurrence line", () => {
    expect(findAllOccurrenceLineNumbers("same\nother\nsame", "same")).toEqual([1, 3]);
  });

  test("returns no occurrences for an empty search", () => {
    expect(findAllOccurrenceLineNumbers("content", "")).toEqual([]);
  });
});
