import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import {
  formatOneShotError,
  formatOneShotResult,
  isRunCostKnown,
  type OneShotSuccess,
} from "./envelope";

const baseResult: OneShotSuccess = {
  answer: "Hello from the agent",
  costUSD: 0.0012,
  costKnown: true,
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
      costKnown: true,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"q":"x"}' }],
    });
  });

  it("omits messages by default", () => {
    const output = formatOneShotResult(baseResult, { json: true });
    expect(JSON.parse(output)).not.toHaveProperty("messages");
  });

  it("includes messages when set (--ephemeral round-trip)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const output = formatOneShotResult({ ...baseResult, messages }, { json: true });
    expect(JSON.parse(output).messages).toEqual(messages);
  });
});

describe("the success envelope's key order", () => {
  // Bridges outside this repo read these keys. Adding one is a compatible change; the
  // shape changing under them without anyone noticing is not.
  it("is exactly ok, answer, costUSD, costKnown, tokenUsage, toolCalls", () => {
    const output = formatOneShotResult(baseResult, { json: true });
    expect(Object.keys(JSON.parse(output))).toEqual([
      "ok",
      "answer",
      "costUSD",
      "costKnown",
      "tokenUsage",
      "toolCalls",
    ]);
  });
});

describe("isRunCostKnown", () => {
  it("accepts provider pricing, including a real zero", () => {
    expect(isRunCostKnown(0, "openai", "free-model")).toBe(true);
    expect(isRunCostKnown(0.01, "openai", "priced-model")).toBe(true);
  });

  it("recognizes local servers as zero-cost without misclassifying Ollama Cloud", () => {
    expect(isRunCostKnown(undefined, "llamacpp", "local.gguf")).toBe(true);
    expect(isRunCostKnown(undefined, "ollama", "qwen3:8b")).toBe(true);
    expect(isRunCostKnown(undefined, "ollama", "kimi-k3:cloud")).toBe(false);
  });

  it("marks missing remote pricing as unknown", () => {
    expect(isRunCostKnown(undefined, "openai", "unlisted-model")).toBe(false);
  });

  it("treats an incomplete total as unknown even when costUSD is defined", () => {
    expect(isRunCostKnown(0.02, "openai", "priced-model", true)).toBe(false);
    expect(isRunCostKnown(undefined, "llamacpp", "local.gguf", true)).toBe(false);
    expect(isRunCostKnown(0.02, "openai", "priced-model", false)).toBe(true);
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
