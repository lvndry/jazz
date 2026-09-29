import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderPendingStream } from "./App";
import { createStreamSplitScanner } from "../presentation/markdown-split";

function pendingStream(rawTail: string, kind: "response" | "reasoning" = "response") {
  return { id: "p1", kind, rawTail, splitScanner: createStreamSplitScanner() };
}

describe("renderPendingStream", () => {
  test("carries markdown styling through the shared parser", () => {
    const rendered = renderPendingStream(pendingStream("**bold** text"), 80);
    expect(rendered).not.toContain("**");
  });

  test("hard-wraps at the available width, unlike settled Ink messages", () => {
    const long = Array.from({ length: 30 }, (_, index) => `word${String(index)}`).join(" ");
    const rendered = renderPendingStream(pendingStream(long), 40);
    expect(rendered.split("\n").length).toBeGreaterThan(1);
  });

  test("every line carries the speaker rail", () => {
    const long = Array.from({ length: 20 }, (_, index) => `word${String(index)}`).join(" ");
    const rendered = renderPendingStream(pendingStream(long), 40);
    for (const line of rendered.split("\n")) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  test("dims reasoning output but leaves a response tail plain", () => {
    try {
      chalk.level = 3;
      const response = renderPendingStream(pendingStream("hello", "response"));
      const reasoning = renderPendingStream(pendingStream("hello", "reasoning"));
      expect(reasoning).not.toBe(response);
    } finally {
      chalk.level = 0;
    }
  });
});
