import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import {
  answerOutcomeFields,
  formatOneShotError,
  formatOneShotResult,
  ONE_SHOT_EXIT,
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

describe("formatOneShotError", () => {
  it("plain mode emits the message with a trailing newline", () => {
    expect(formatOneShotError("Agent not found", { json: false })).toBe("Agent not found\n");
  });

  it("json mode carries what a failed run spent", () => {
    expect(
      JSON.parse(
        formatOneShotError(
          "boom",
          { json: true },
          { costUSD: 0.5, costKnown: true, totalTokens: 1_000 },
        ),
      ),
    ).toEqual({
      ok: false,
      error: "boom",
      code: "failed",
      costUSD: 0.5,
      costKnown: true,
      tokenUsage: { totalTokens: 1_000 },
    });
  });

  it("json mode reports an unpriced failed run as unknown, not free", () => {
    const envelope = JSON.parse(
      formatOneShotError("boom", { json: true }, { costKnown: false, totalTokens: 300 }),
    );
    expect(envelope.costUSD).toBe(0);
    expect(envelope.costKnown).toBe(false);
  });

  it("json mode carries the failure's code, finish reason and signal", () => {
    expect(
      JSON.parse(
        formatOneShotError("The model stopped without answering.", { json: true }, undefined, {
          code: "no_answer",
          finishReason: "length",
          toolsDisabled: true,
        }),
      ),
    ).toEqual({
      ok: false,
      error: "The model stopped without answering.",
      code: "no_answer",
      costUSD: 0,
      finishReason: "length",
      toolsDisabled: true,
    });
    expect(
      JSON.parse(
        formatOneShotError("interrupted", { json: true }, undefined, {
          code: "interrupted",
          signal: "SIGTERM",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "interrupted",
      code: "interrupted",
      costUSD: 0,
      signal: "SIGTERM",
    });
  });

  it("json mode lists the calls of a batch the failure stopped", () => {
    const stopped = [
      { id: "a", name: "read_file", status: "completed" as const },
      { id: "b", name: "execute_command", status: "interrupted" as const },
    ];
    expect(
      JSON.parse(
        formatOneShotError("timeout", { json: true }, undefined, { stoppedToolCalls: stopped }),
      ),
    ).toEqual({
      ok: false,
      error: "timeout",
      code: "failed",
      costUSD: 0,
      stoppedToolCalls: stopped,
    });
  });

  it("json mode defaults costUSD to 0", () => {
    expect(JSON.parse(formatOneShotError("boom", { json: true })).costUSD).toBe(0);
  });
});

describe("answerOutcomeFields", () => {
  it("adds nothing for a complete answer", () => {
    expect(answerOutcomeFields({})).toEqual({});
  });

  it("marks a length finish as truncated and keeps the finish reason", () => {
    expect(answerOutcomeFields({ finishReason: "length" })).toEqual({
      finishReason: "length",
      truncated: true,
    });
  });

  it("surfaces iteration limits and dropped tools in the success envelope", () => {
    const fields = answerOutcomeFields({
      finishReason: "stop",
      iterationLimited: true,
      toolsDisabled: true,
    });
    const envelope = JSON.parse(formatOneShotResult({ ...baseResult, ...fields }, { json: true }));

    expect(envelope).toMatchObject({
      ok: true,
      finishReason: "stop",
      iterationLimited: true,
      toolsDisabled: true,
    });
    expect(envelope).not.toHaveProperty("truncated");
  });
});

describe("ONE_SHOT_EXIT", () => {
  it("uses the shell's 128 + signal convention for interruptions", () => {
    expect(ONE_SHOT_EXIT.interrupted).toBe(130);
    expect(ONE_SHOT_EXIT.terminated).toBe(143);
  });
});
