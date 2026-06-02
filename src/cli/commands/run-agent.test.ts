import { describe, expect, it } from "bun:test";
import {
  formatOneShotError,
  formatOneShotResult,
  isApprovalPolicyFlag,
  type OneShotSuccess,
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
