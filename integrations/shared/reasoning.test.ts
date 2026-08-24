import { describe, expect, test } from "bun:test";
import {
  PROGRESS_REASONING_CHARS,
  reasoningSnippet,
  splitReasoning,
  tidyReasoning,
} from "./reasoning";

describe("reasoningSnippet", () => {
  test("renders a short thought whole, on one line", () => {
    expect(reasoningSnippet("  I need\n the duration.  ")).toBe("I need the duration.");
  });

  test("returns empty for whitespace-only reasoning so no 💭 line is drawn", () => {
    expect(reasoningSnippet("   \n\t ")).toBe("");
  });

  test("shows the tail, not the head, of a long thought", () => {
    const reasoning = `${"a".repeat(500)} and finally the newest thought`;
    const snippet = reasoningSnippet(reasoning);
    expect(snippet.startsWith("… ")).toBe(true);
    expect(snippet.endsWith("and finally the newest thought")).toBe(true);
    expect(snippet.length).toBeLessThan(reasoning.length);
  });

  test("drops a chopped-off leading word fragment", () => {
    const reasoning = `${"x".repeat(400)}fragment ${"word ".repeat(30)}`;
    expect(reasoningSnippet(reasoning)).not.toContain("fragment");
  });

  test("keeps a long leading run rather than eating a real word", () => {
    const tail = `${"y".repeat(60)} ${"word ".repeat(20)}`;
    const snippet = reasoningSnippet(`${"z".repeat(400)} ${tail}`);
    expect(snippet).toContain("y".repeat(60));
  });

  test("stays within the advertised budget plus the ellipsis marker", () => {
    const snippet = reasoningSnippet("word ".repeat(500));
    expect(snippet.length).toBeLessThanOrEqual(PROGRESS_REASONING_CHARS + 2);
  });
});

describe("tidyReasoning", () => {
  test("keeps paragraph breaks but collapses longer blank runs", () => {
    expect(tidyReasoning("one\n\n\n\ntwo")).toBe("one\n\ntwo");
  });

  test("normalises carriage returns and strips trailing spaces", () => {
    expect(tidyReasoning("one   \r\ntwo\t\r\n")).toBe("one\ntwo");
  });
});

describe("splitReasoning", () => {
  const options = { budget: 100, maxParts: 3 };

  test("returns nothing for empty reasoning", () => {
    expect(splitReasoning("   \n  ", options)).toEqual([]);
  });

  test("returns a single part when it fits", () => {
    expect(splitReasoning("short thought", options)).toEqual(["short thought"]);
  });

  test("keeps every part within budget", () => {
    for (const part of splitReasoning("word ".repeat(50), options)) {
      expect(part.length).toBeLessThanOrEqual(options.budget);
    }
  });

  test("prefers a line break in the back half of the window", () => {
    const reasoning = `${"a".repeat(80)}\n${"b".repeat(80)}`;
    const parts = splitReasoning(reasoning, options);
    expect(parts[0]).toBe("a".repeat(80));
    expect(parts[1]).toBe("b".repeat(80));
  });

  test("loses no text when it splits", () => {
    const reasoning = "word ".repeat(40).trim();
    const parts = splitReasoning(reasoning, options);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ")).toBe(reasoning);
  });

  test("says how much it dropped rather than truncating silently", () => {
    const parts = splitReasoning("word ".repeat(500), options);
    expect(parts).toHaveLength(options.maxParts);
    expect(parts.at(-1)).toMatch(/\[… [\d,]+ more characters of reasoning not shown\]$/);
  });

  test("adds no dropped note when the last part lands exactly on the cap", () => {
    const reasoning = `${"a".repeat(90)}\n${"b".repeat(90)}`;
    const parts = splitReasoning(reasoning, { budget: 100, maxParts: 2 });
    expect(parts).toHaveLength(2);
    expect(parts.at(-1)).toBe("b".repeat(90));
  });

  test("splits unbroken text that offers no word boundary at all", () => {
    const parts = splitReasoning("a".repeat(250), options);
    expect(parts.join("")).toBe("a".repeat(250));
  });
});
