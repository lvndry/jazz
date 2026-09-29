/** Exercises the live Ink stream's rendered text, wrapping, speaker rail, and reasoning styling. */
import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderPendingStream } from "./App";
import { getGlyphs } from "./glyphs";
import { createStreamSplitScanner } from "../presentation/markdown-split";
import { stripAnsiCodes } from "../utils/string-utils";
import { terminalCellWidth } from "./text/terminal-cells";

function pendingStream(rawTail: string, kind: "response" | "reasoning" = "response") {
  return { id: "p1", kind, rawTail, splitScanner: createStreamSplitScanner() };
}

describe("renderPendingStream", () => {
  test("carries markdown styling through the shared parser", () => {
    const rendered = renderPendingStream(pendingStream("**bold** text"), 80);
    expect(rendered).not.toContain("**");
    expect(stripAnsiCodes(rendered)).toContain("bold text");
  });

  test("wraps within the terminal width and preserves text behind every speaker rail", () => {
    const long = Array.from({ length: 30 }, (_, index) => `word${String(index)}`).join(" ");
    const rendered = renderPendingStream(pendingStream(long), 40);
    const lines = stripAnsiCodes(rendered).split("\n");
    const rail = `${getGlyphs().rail} `;
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith(rail)).toBe(true);
      expect(terminalCellWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.map((line) => line.slice(rail.length).trim()).join(" ")).toBe(long);
  });

  test("dims reasoning output but leaves a response tail plain", () => {
    try {
      chalk.level = 3;
      const response = renderPendingStream(pendingStream("hello", "response"), 80);
      const reasoning = renderPendingStream(pendingStream("hello", "reasoning"), 80);
      expect(reasoning).not.toBe(response);
    } finally {
      chalk.level = 0;
    }
  });
});
