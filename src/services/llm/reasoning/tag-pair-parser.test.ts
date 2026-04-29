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

  it("splits a single complete <think>...</think> block in one feed", () => {
    const parser = new TagPairParser();
    const out = parser.feed("before<think>secret</think>after");
    expect(out.visibleText).toBe("beforeafter");
    expect(out.thinkingText).toBe("secret");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });
});
