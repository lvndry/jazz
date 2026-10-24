import { describe, expect, it } from "bun:test";
import { lineDeleteStart } from "./line-delete";

describe("lineDeleteStart", () => {
  it("deletes back to the start of the current line", () => {
    expect(lineDeleteStart("first\nsecond", 12)).toBe(6);
    expect(lineDeleteStart("only line", 4)).toBe(0);
  });

  it("deletes the preceding line break when the caret is at a line start", () => {
    expect(lineDeleteStart("first\nsecond", 6)).toBe(5);
  });

  it("deletes the line break that left an empty line", () => {
    expect(lineDeleteStart("first\n", 6)).toBe(5);
    expect(lineDeleteStart("first\n\nthird", 7)).toBe(6);
  });

  it("does nothing at the very start of the text", () => {
    expect(lineDeleteStart("", 0)).toBe(0);
    expect(lineDeleteStart("text", 0)).toBe(0);
  });

  it("indexes code points when given an array", () => {
    expect(lineDeleteStart([..."🎷\n"], 2)).toBe(1);
    expect(lineDeleteStart([..."a\n🎷🎷"], 4)).toBe(2);
  });
});
