import { describe, expect, test } from "bun:test";
import { composeRecalledBuffer, isCursorOnFirstLine } from "./queue-recall";

describe("isCursorOnFirstLine", () => {
  test("true for an empty buffer", () => {
    expect(isCursorOnFirstLine("", 0)).toBe(true);
  });

  test("true anywhere in a single-line buffer", () => {
    expect(isCursorOnFirstLine("hello", 0)).toBe(true);
    expect(isCursorOnFirstLine("hello", 3)).toBe(true);
    expect(isCursorOnFirstLine("hello", 5)).toBe(true);
  });

  test("true on the first line of a multiline buffer, including at the newline", () => {
    expect(isCursorOnFirstLine("ab\ncd", 0)).toBe(true);
    expect(isCursorOnFirstLine("ab\ncd", 2)).toBe(true);
  });

  test("false once the cursor is past the first newline", () => {
    expect(isCursorOnFirstLine("ab\ncd", 3)).toBe(false);
    expect(isCursorOnFirstLine("ab\ncd", 5)).toBe(false);
  });
});

describe("composeRecalledBuffer", () => {
  test("queue only: buffer is the queue text, cursor at end", () => {
    expect(composeRecalledBuffer("first\nsecond", "")).toEqual({
      value: "first\nsecond",
      cursor: "first\nsecond".length,
    });
  });

  test("queue + draft: draft is preserved below the queue text, cursor at end", () => {
    expect(composeRecalledBuffer("queued", "my draft")).toEqual({
      value: "queued\nmy draft",
      cursor: "queued\nmy draft".length,
    });
  });

  test("multiline queue + draft keeps chronological order", () => {
    expect(composeRecalledBuffer("one\ntwo", "three")).toEqual({
      value: "one\ntwo\nthree",
      cursor: "one\ntwo\nthree".length,
    });
  });
});
