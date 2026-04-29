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

  it("stitches an open tag split across two feeds", () => {
    const parser = new TagPairParser();
    const a = parser.feed("a<thi");
    const b = parser.feed("nk>secret</think>after");
    expect(a.visibleText).toBe("a");
    expect(a.thinkingText).toBe("");
    expect(a.thinkingStarted).toBeUndefined();

    expect(b.visibleText).toBe("after");
    expect(b.thinkingText).toBe("secret");
    expect(b.thinkingStarted).toBe(true);
    expect(b.thinkingEnded).toBe(true);
  });

  it("stitches a close tag split across two feeds", () => {
    const parser = new TagPairParser();
    const a = parser.feed("a<think>secr");
    const b = parser.feed("et</thi");
    const c = parser.feed("nk>after");
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("secr");
    expect(b.thinkingText).toBe("et");
    expect(c.thinkingEnded).toBe(true);
    expect(c.visibleText).toBe("after");
  });
});
