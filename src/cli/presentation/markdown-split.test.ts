import { describe, expect, test } from "bun:test";
import {
  createStreamSplitScanner,
  findLastSafeSplitPoint,
  MAX_PENDING_TAIL,
  SOFT_TAIL,
} from "./markdown-split";

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
    name: "no newline within cap falls back to nearest word boundary before the cap",
    // A space sits 100 chars before the cap; no newline anywhere in the text.
    input: "a".repeat(MAX_PENDING_TAIL - 100) + " " + "b".repeat(5000),
    expected: MAX_PENDING_TAIL - 100 + 1,
  },
  {
    name: "no newline and no whitespace within search window cuts at the hard cap",
    input: "a".repeat(MAX_PENDING_TAIL + 5000),
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
    name: "list block followed by an in-flight paragraph splits at the list end",
    // The paragraph after the list has no newline yet, so the only boundary
    // on offer is the end of the list block.
    input: "- a\n- b\nprose that is still streaming " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.lastIndexOf("- b\n") + "- b\n".length,
  },
  {
    name: "sentence end before a blank line defers to the blank line",
    input: "one sentence.\n\nsecond paragraph " + "x".repeat(SOFT_TAIL),
    expected: (s) => s.indexOf("\n\n") + 2,
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

describe("createStreamSplitScanner", () => {
  const document =
    "# Title\n\nIntro paragraph that runs on for a while. It has two sentences.\n\n" +
    "- first item\n- second item\n- third item\n\n" +
    "Prose between the list and the code block.\n\n" +
    "```ts\nconst value = 1;\nconst other = value + 1;\n```\n\n" +
    "| header | header |\n| --- | --- |\n| cell | cell |\n\n" +
    "Closing paragraph with `inline code`, **bold**, and [a link](http://example.com).\n\n" +
    "x".repeat(SOFT_TAIL + 100);

  function chunkSizes(seed: number, max: number): number[] {
    const sizes: number[] = [];
    let state = seed;
    for (let index = 0; index < 4000; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      sizes.push(1 + Math.floor((state / 0x7fffffff) * max));
    }
    return sizes;
  }

  test("incremental feeding matches the one-shot result at every step", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const scanner = createStreamSplitScanner();
      const sizes = chunkSizes(seed, 12);
      let consumed = 0;
      let sizeIndex = 0;
      while (consumed < document.length) {
        consumed = Math.min(document.length, consumed + sizes[sizeIndex++]!);
        const text = document.slice(0, consumed);
        expect(scanner.evaluate(text)).toBe(findLastSafeSplitPoint(text));
      }
    }
  });

  test("one delta at a time matches the one-shot result at every step", () => {
    const scanner = createStreamSplitScanner();
    for (let length = 1; length <= document.length; length += 1) {
      const text = document.slice(0, length);
      expect(scanner.evaluate(text)).toBe(findLastSafeSplitPoint(text));
    }
  });

  test("re-evaluating the same text is stable", () => {
    const scanner = createStreamSplitScanner();
    const first = scanner.evaluate(document);
    expect(scanner.evaluate(document)).toBe(first);
    expect(scanner.evaluate(document)).toBe(findLastSafeSplitPoint(document));
  });

  test("reset lets a scanner be reused on an unrelated tail", () => {
    const scanner = createStreamSplitScanner();
    scanner.evaluate(document);
    scanner.reset();
    const other = "para 1.\n\npara 2 in flight " + "x".repeat(SOFT_TAIL);
    expect(scanner.evaluate(other)).toBe(findLastSafeSplitPoint(other));
  });

  test("promoting and rebasing the tail stays lossless across a stream", () => {
    let pending = "";
    let scanner = createStreamSplitScanner();
    const promoted: string[] = [];
    for (let index = 0; index < document.length; index += 3) {
      pending += document.slice(index, index + 3);
      const split = scanner.evaluate(pending);
      if (split > 0) {
        promoted.push(pending.slice(0, split));
        pending = pending.slice(split);
        scanner = createStreamSplitScanner();
      }
    }
    expect(promoted.length).toBeGreaterThan(3);
    expect(promoted.join("") + pending).toBe(document);
  });
});
