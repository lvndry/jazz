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

  it("treats <table> and other non-reasoning tags as visible text", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<table>row</table>b");
    expect(out.visibleText).toBe("a<table>row</table>b");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
  });

  it("emits an unmatched lone < as visible text", () => {
    const parser = new TagPairParser();
    const out = parser.feed("2 < 3 is true");
    expect(out.visibleText).toBe("2 < 3 is true");
  });

  it("suppresses thinking events for an empty <think></think> block", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<think></think>b");
    expect(out.visibleText).toBe("ab");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("suppresses thinking events for whitespace-only <think>\\n\\n</think>", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<think>\n\n</think>b");
    expect(out.visibleText).toBe("ab");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("emits thinking events when first non-whitespace appears after leading whitespace", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<think>\n  reasoning</think>b");
    expect(out.visibleText).toBe("ab");
    expect(out.thinkingText).toBe("\n  reasoning");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });

  it("flushes a partial open-tag buffer as visible text", () => {
    const parser = new TagPairParser();
    const a = parser.feed("a<thi");
    const b = parser.flush();
    expect(a.visibleText).toBe("a");
    expect(b.visibleText).toBe("<thi");
    expect(b.thinkingText).toBe("");
  });

  it("flushes mid-thinking content with thinkingEnded set", () => {
    const parser = new TagPairParser();
    const a = parser.feed("a<think>partial");
    const b = parser.flush();
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("partial");
    expect(b.thinkingEnded).toBe(true);
  });

  it("flushes mid-MAYBE_CLOSE buffer back into thinking text", () => {
    const parser = new TagPairParser();
    const a = parser.feed("a<think>secret</thi");
    const b = parser.flush();
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("secret");
    expect(b.thinkingText).toBe("</thi");
    expect(b.thinkingEnded).toBe(true);
  });

  it("returns empty chunks on flush after a clean stream", () => {
    const parser = new TagPairParser();
    parser.feed("a<think>x</think>b");
    const out = parser.flush();
    expect(out.visibleText).toBe("");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("recognises <THINK>, <Thinking>, and mixed-case close tags", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<THINK>x</Think>b<Thinking>y</THINKING>c");
    expect(out.visibleText).toBe("abc");
    expect(out.thinkingText).toBe("xy");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });

  it("handles two thinking blocks in one feed", () => {
    const parser = new TagPairParser();
    const out = parser.feed("a<think>one</think>b<think>two</think>c");
    expect(out.visibleText).toBe("abc");
    expect(out.thinkingText).toBe("onetwo");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });
});
