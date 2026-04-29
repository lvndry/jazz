import { describe, expect, test } from "bun:test";
import { findLastSafeSplitPoint, MAX_PENDING_TAIL, SOFT_TAIL } from "./markdown-split";

interface Case {
  name: string;
  input: string;
  /** Expected split offset, or a function that derives it from the input. */
  expected: number | ((s: string) => number);
}

const cases: Case[] = [
  { name: "empty string returns 0", input: "", expected: 0 },
  {
    name: "single short paragraph stays in soft tail",
    input: "hello world",
    expected: 0,
  },
  {
    name: "two paragraphs split right after the blank line",
    input:
      "para 1.\n\npara 2 in flight that is long enough to escape soft tail " +
      "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
  {
    name: "open code fence forbids any split past its start",
    // Split at the start of the fence line (i.e., right after the preceding \n).
    // The trailing \n is included in the prefix by convention.
    input: "before fence " + "x".repeat(SOFT_TAIL) + "\n```js\nlet x = 1\n",
    expected: (s) => s.indexOf("\n```") + 1,
  },
  {
    name: "closed code fence allows split right after closing line",
    input: "intro\n\n```\nx\n```\n" + "y".repeat(SOFT_TAIL + 50),
    expected: (s) => s.indexOf("```\n", s.indexOf("```") + 3) + "```\n".length,
  },
  {
    name: "open list clamps split before the list",
    input: "para.\n\n- a\n- b in flight " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
  {
    name: "20KB blob with no structure falls back to last newline before MAX_PENDING_TAIL",
    input: "a".repeat(MAX_PENDING_TAIL - 1) + "\n" + "b".repeat(5000),
    // Newline sits at index MAX_PENDING_TAIL - 1; function returns idx + 1.
    expected: MAX_PENDING_TAIL,
  },
  {
    name: "inline code spanning split rejects offset inside backticks",
    input: "para 1.\n\n`open code without close " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
  {
    name: "bold spanning split rejects offset inside **",
    input: "para 1.\n\n**unclosed bold " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
  {
    name: "link spanning split rejects offset inside [..](..)",
    input: "para 1.\n\n[label](http " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
  {
    name: "splitting twice on the post-split tail is stable",
    input: "para 1.\n\npara 2.\n\n" + "x".repeat(SOFT_TAIL + 100),
    // findLastBlankLine finds the last \n\n before upperBound — the second one
    // after "para 2." — so the promoted chunk is "para 1.\n\npara 2.\n\n".
    expected: (s) => s.lastIndexOf("\n\n") + 2,
  },
  {
    name: "mismatched fence chars do not pair: ``` opened, ~~~ does not close it",
    input: "intro\n```js\nx\n~~~\nstill inside fence " + "x".repeat(SOFT_TAIL),
    // The ``` fence is still open. Floor is at position of \n```.
    expected: (s) => s.indexOf("```"),
  },
  {
    name: "single-star italic spanning split rejects offset inside *",
    input: "para 1.\n\n*unclosed italic " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
  },
];

describe("findLastSafeSplitPoint", () => {
  for (const c of cases) {
    test(c.name, () => {
      const expected = typeof c.expected === "function" ? c.expected(c.input) : c.expected;
      expect(findLastSafeSplitPoint(c.input)).toBe(expected);
    });
  }

  test("idempotency: feeding the post-split tail back yields a stable boundary", () => {
    const text = "para 1.\n\npara 2.\n\n" + "x".repeat(SOFT_TAIL + 100);
    const first = findLastSafeSplitPoint(text);
    expect(first).toBeGreaterThan(0);
    const tail = text.slice(first);
    const second = findLastSafeSplitPoint(tail);
    // The second call may be 0 (tail too short) or > 0 (another paragraph break
    // in the tail). It must not be greater than `tail.length`, must be < `text.length - first`.
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThanOrEqual(tail.length);
  });
});
