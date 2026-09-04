import { describe, expect, it } from "bun:test";
import { MAX_PROGRESS_RESULT_CHARS } from "@/core/types/tools";
import { toolResultForProgress } from "./tool-result-formatter";

describe("toolResultForProgress", () => {
  it("passes a result through as it is, newlines and all", () => {
    // Formatting is the listener's business: a status line and a log pane want different
    // things from the same result, and folding it here would decide for both.
    expect(toolResultForProgress("first\n  second")).toEqual({
      text: "first\n  second",
      truncated: false,
    });
  });

  it("renders a structured result as JSON", () => {
    expect(toolResultForProgress({ matches: 3 })).toEqual({
      text: '{"matches":3}',
      truncated: false,
    });
  });

  it("cuts a result at the transport ceiling and says that it did", () => {
    const returned = toolResultForProgress("x".repeat(MAX_PROGRESS_RESULT_CHARS * 2));
    expect(returned?.text).toHaveLength(MAX_PROGRESS_RESULT_CHARS);
    expect(returned?.truncated).toBe(true);
  });

  it("leaves a result exactly at the ceiling whole", () => {
    const returned = toolResultForProgress("x".repeat(MAX_PROGRESS_RESULT_CHARS));
    expect(returned?.truncated).toBe(false);
  });

  it("says nothing rather than something empty", () => {
    expect(toolResultForProgress(undefined)).toBeUndefined();
    expect(toolResultForProgress(null)).toBeUndefined();
    expect(toolResultForProgress("")).toBeUndefined();
  });

  it("reports a result it could not serialize rather than going quiet", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(toolResultForProgress(cyclic)?.text).toContain("Failed to serialize");
  });
});
