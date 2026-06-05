import { describe, expect, it } from "bun:test";
import {
  formatOneShotError,
  formatOneShotResult,
  isApprovalPolicyFlag,
  isReasoningEffortFlag,
  type OneShotSuccess,
  parseEventCategories,
} from "./run-agent";

const baseResult: OneShotSuccess = {
  answer: "Hello from the agent",
  costUSD: 0.0012,
  tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"q":"x"}' }],
};

describe("formatOneShotResult", () => {
  it("plain mode emits only the trimmed answer with a trailing newline", () => {
    const output = formatOneShotResult({ ...baseResult, answer: "  Hello  \n\n" }, { json: false });
    expect(output).toBe("Hello\n");
  });

  it("plain mode does not include header, footer, or JSON envelope keys", () => {
    const output = formatOneShotResult(baseResult, { json: false });
    expect(output).not.toContain("◉");
    expect(output).not.toContain("completed");
    expect(output).not.toContain('"ok"');
  });

  it("json mode emits exactly one single-line envelope", () => {
    const output = formatOneShotResult(baseResult, { json: true });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(output)).toEqual({
      ok: true,
      answer: "Hello from the agent",
      costUSD: 0.0012,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"q":"x"}' }],
    });
  });
});

describe("formatOneShotError", () => {
  it("plain mode emits the message with a trailing newline", () => {
    expect(formatOneShotError("Agent not found", { json: false })).toBe("Agent not found\n");
  });

  it("json mode emits an ok:false envelope including costUSD", () => {
    expect(JSON.parse(formatOneShotError("boom", { json: true }, 0.5))).toEqual({
      ok: false,
      error: "boom",
      costUSD: 0.5,
    });
  });

  it("json mode defaults costUSD to 0", () => {
    expect(JSON.parse(formatOneShotError("boom", { json: true })).costUSD).toBe(0);
  });
});

describe("isApprovalPolicyFlag", () => {
  it("accepts the three risk levels", () => {
    expect(isApprovalPolicyFlag("read-only")).toBe(true);
    expect(isApprovalPolicyFlag("low-risk")).toBe(true);
    expect(isApprovalPolicyFlag("high-risk")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isApprovalPolicyFlag("all")).toBe(false);
    expect(isApprovalPolicyFlag("")).toBe(false);
  });
});

describe("parseEventCategories", () => {
  it("maps 'tools' to the four tool event types plus error", () => {
    const result = parseEventCategories("tools");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.types].sort()).toEqual(
      [
        "error",
        "tool_call",
        "tool_execution_complete",
        "tool_execution_start",
        "tools_detected",
      ].sort(),
    );
  });

  it("maps 'all' to every category type plus error", () => {
    const result = parseEventCategories("all");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = [
      "error",
      "tools_detected",
      "tool_call",
      "tool_execution_start",
      "tool_execution_complete",
      "thinking_start",
      "thinking_chunk",
      "thinking_complete",
      "text_start",
      "text_chunk",
      "stream_start",
      "usage_update",
      "complete",
    ];
    expect([...result.types].sort()).toEqual(expected.sort());
  });

  it("unions multiple categories", () => {
    const result = parseEventCategories("tools,reasoning");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.types.has("tool_execution_start")).toBe(true);
    expect(result.types.has("thinking_chunk")).toBe(true);
    expect(result.types.has("text_chunk")).toBe(false);
    expect(result.types.has("error")).toBe(true);
  });

  it("tolerates whitespace and case", () => {
    const result = parseEventCategories(" Tools , TEXT ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.types.has("tool_execution_start")).toBe(true);
    expect(result.types.has("text_chunk")).toBe(true);
  });

  it("rejects an unknown category with a helpful message", () => {
    const result = parseEventCategories("bogus");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'Invalid --events category "bogus". Expected: tools, reasoning, text, usage, all.',
    );
  });

  it.each(["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"])(
    "rejects inherited Object.prototype key %p instead of treating it as a category",
    (inheritedKey) => {
      const result = parseEventCategories(inheritedKey);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Invalid --events category");
    },
  );
});

describe("isReasoningEffortFlag", () => {
  it("accepts the four reasoning levels", () => {
    expect(isReasoningEffortFlag("disable")).toBe(true);
    expect(isReasoningEffortFlag("low")).toBe(true);
    expect(isReasoningEffortFlag("medium")).toBe(true);
    expect(isReasoningEffortFlag("high")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReasoningEffortFlag("off")).toBe(false);
    expect(isReasoningEffortFlag("none")).toBe(false);
    expect(isReasoningEffortFlag("")).toBe(false);
    expect(isReasoningEffortFlag("HIGH")).toBe(false);
  });
});
