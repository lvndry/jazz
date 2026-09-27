import { describe, expect, test } from "bun:test";
import {
  buildLineOffsets,
  coerceBoolean,
  findAllOccurrenceLineNumbers,
  formatCompactCount,
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

describe("formatCompactCount", () => {
  test("steps through 100, 1k, 10k, 1M, 1B", () => {
    expect(formatCompactCount(100)).toBe("100");
    expect(formatCompactCount(999)).toBe("999");
    expect(formatCompactCount(1_000)).toBe("1k");
    expect(formatCompactCount(1_500)).toBe("1.5k");
    expect(formatCompactCount(10_000)).toBe("10k");
    expect(formatCompactCount(20_000)).toBe("20k");
    expect(formatCompactCount(1_000_000)).toBe("1M");
    expect(formatCompactCount(1_500_000)).toBe("1.5M");
    expect(formatCompactCount(10_000_000)).toBe("10M");
    expect(formatCompactCount(1_000_000_000)).toBe("1B");
    expect(formatCompactCount(2_300_000_000)).toBe("2.3B");
    expect(formatCompactCount(999_500)).toBe("1M");
  });
});
