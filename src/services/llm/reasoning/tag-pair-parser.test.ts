import { describe, expect, it } from "bun:test";
import { TagPairParser } from "./tag-pair-parser";

describe("TagPairParser", () => {
  it("passes plain text through as visibleText", () => {
    const parser = new TagPairParser();
    const out = parser.feed("hello world");
    expect(out.visibleText).toBe("hello world");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });
});
