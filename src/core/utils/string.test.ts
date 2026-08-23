import { describe, expect, test } from "bun:test";
import {
  buildLineOffsets,
  coerceBoolean,
  findAllOccurrenceLineNumbers,
  offsetToLine,
} from "./string";

describe("coerceBoolean", () => {
  test("accepts real booleans", () => {
    expect(coerceBoolean(true, false)).toBe(true);
    expect(coerceBoolean(false, true)).toBe(false);
  });

  test("accepts the strings jazz config set stores", () => {
    expect(coerceBoolean("true", false)).toBe(true);
    expect(coerceBoolean("false", true)).toBe(false);
  });

  test("falls back for anything else", () => {
    expect(coerceBoolean(undefined, true)).toBe(true);
    expect(coerceBoolean("yes", false)).toBe(false);
    expect(coerceBoolean(1, false)).toBe(false);
  });
});

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
