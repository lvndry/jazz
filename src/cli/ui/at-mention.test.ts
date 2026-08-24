import { describe, expect, test } from "bun:test";
import { applyAtMention, atMentionSpan } from "./at-mention";

describe("atMentionSpan", () => {
  test("finds a mention at the start of the line", () => {
    expect(atMentionSpan("@src/foo", 8)).toEqual({ query: "src/foo", start: 0, end: 8 });
  });

  test("finds a mention after whitespace", () => {
    expect(atMentionSpan("look at @src/foo", 16)).toEqual({
      query: "src/foo",
      start: 8,
      end: 16,
    });
  });

  test("opens on a bare @ so the menu can show everything", () => {
    expect(atMentionSpan("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  test("ignores an @ inside a word", () => {
    // An email address must not turn the picker on.
    expect(atMentionSpan("mail me@example.com", 19)).toBeNull();
    expect(atMentionSpan("a@b", 3)).toBeNull();
  });

  test("closes at whitespace after the query", () => {
    expect(atMentionSpan("@src/foo and", 12)).toBeNull();
  });

  test("uses the caret, not the end of the line", () => {
    // Caret sits inside the first mention while a second one follows.
    expect(atMentionSpan("@one @two", 4)).toEqual({ query: "one", start: 0, end: 4 });
  });

  test("finds the mention the caret is in when there are several", () => {
    expect(atMentionSpan("@one @two", 9)).toEqual({ query: "two", start: 5, end: 9 });
  });

  test("returns null with no mention present", () => {
    expect(atMentionSpan("", 0)).toBeNull();
    expect(atMentionSpan("plain text", 10)).toBeNull();
  });

  test("clamps an out-of-range caret", () => {
    expect(atMentionSpan("@abc", 99)).toEqual({ query: "abc", start: 0, end: 4 });
    expect(atMentionSpan("@abc", -5)).toBeNull();
  });

  test("does not treat a slash command as a mention", () => {
    expect(atMentionSpan("/model", 6)).toBeNull();
  });
});

describe("applyAtMention", () => {
  test("replaces the span and leaves the caret after a trailing space", () => {
    const span = atMentionSpan("@src/f", 6);
    expect(span).not.toBeNull();
    expect(applyAtMention("@src/f", span!, "src/foo.ts")).toEqual({
      text: "@src/foo.ts ",
      caret: 12,
    });
  });

  test("keeps text on both sides intact", () => {
    const text = "compare @src/f with the spec";
    const span = atMentionSpan(text, 14);
    expect(applyAtMention(text, span!, "src/foo.ts")).toEqual({
      text: "compare @src/foo.ts  with the spec",
      caret: 20,
    });
  });

  test("expands a bare @ into the chosen path", () => {
    const span = atMentionSpan("@", 1);
    expect(applyAtMention("@", span!, "README.md")).toEqual({
      text: "@README.md ",
      caret: 11,
    });
  });
});

describe("code-point offsets", () => {
  // The composer's caret counts code points, so an astral character before the
  // mention would shift every UTF-16 index by one and corrupt the replacement.
  const text = "🎷 look at @src/f";
  const caret = [...text].length;

  test("locates a mention after an astral character", () => {
    expect(atMentionSpan(text, caret)).toEqual({ query: "src/f", start: 10, end: 16 });
  });

  test("replaces correctly with an astral character present", () => {
    const span = atMentionSpan(text, caret);
    const applied = applyAtMention(text, span!, "src/foo.ts");
    expect(applied.text).toBe("🎷 look at @src/foo.ts ");
    expect([...applied.text].length).toBe(applied.caret);
  });

  test("handles an astral character inside the chosen path", () => {
    const span = atMentionSpan("@s", 2);
    const applied = applyAtMention("@s", span!, "notes/🎺.md");
    expect(applied.text).toBe("@notes/🎺.md ");
    expect([...applied.text].length).toBe(applied.caret);
  });
});
