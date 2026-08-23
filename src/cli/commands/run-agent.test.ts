import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  loadConversation,
  saveConversation,
  type ConversationRecord,
} from "@/services/history/conversation-history-service";
import {
  buildConversationRecord,
  formatOneShotError,
  formatOneShotResult,
  isApprovalPolicyFlag,
  isRunCostKnown,
  isReasoningEffortFlag,
  type OneShotSuccess,
  parseEventCategories,
  composeResumedHistory,
} from "./run-agent";

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
      "approval_required",
      "approval_resolved",
      "subagent_start",
      "subagent_complete",
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
      'Invalid --events category "bogus". Expected: tools, reasoning, text, usage, approval, subagent, all.',
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

describe("--conversation persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-run-conversation-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
    return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
  }

  // Mirrors what runAgentOnceCommand does around AgentRunner.run for a
  // `--conversation` invocation: load prior record, run, persist the turn.
  async function simulateTurn(params: {
    conversationId: string;
    prompt: string;
    responseContent: string;
    responseMessages?: ChatMessage[];
  }): Promise<ConversationRecord | null> {
    const priorRecord = await runEffect(loadConversation("agent-1", params.conversationId, tmpDir));
    const record = buildConversationRecord({
      agentId: "agent-1",
      conversationId: params.conversationId,
      prompt: params.prompt,
      priorRecord,
      responseContent: params.responseContent,
      responseMessages: params.responseMessages,
      now: new Date().toISOString(),
    });
    await runEffect(saveConversation(record, tmpDir));
    return priorRecord;
  }

  it("a fresh conversation id creates a persisted conversation", async () => {
    const priorRecord = await simulateTurn({
      conversationId: "telegram-42",
      prompt: "Remember my name is Ada",
      responseContent: "Noted, Ada!",
    });

    expect(priorRecord).toBeNull();
    const saved = await runEffect(loadConversation("agent-1", "telegram-42", tmpDir));
    expect(saved).not.toBeNull();
    expect(saved?.conversationId).toBe("telegram-42");
    expect(saved?.title).toBe("Remember my name is Ada");
    expect(saved?.messages).toEqual([
      { role: "user", content: "Remember my name is Ada" },
      { role: "assistant", content: "Noted, Ada!" },
    ]);
  });

  it("a second call with the same id sees the prior turn as context", async () => {
    await simulateTurn({
      conversationId: "telegram-42",
      prompt: "Remember my name is Ada",
      responseContent: "Noted, Ada!",
    });

    const priorRecord = await simulateTurn({
      conversationId: "telegram-42",
      prompt: "What is my name?",
      responseContent: "Your name is Ada.",
    });

    expect(priorRecord?.messages).toEqual([
      { role: "user", content: "Remember my name is Ada" },
      { role: "assistant", content: "Noted, Ada!" },
    ]);

    const saved = await runEffect(loadConversation("agent-1", "telegram-42", tmpDir));
    expect(saved?.messages).toHaveLength(4);
    expect(saved?.messages.at(-1)).toEqual({ role: "assistant", content: "Your name is Ada." });
  });

  it("repeated turns upsert a single record instead of duplicating", async () => {
    await simulateTurn({ conversationId: "telegram-42", prompt: "one", responseContent: "1" });
    await simulateTurn({ conversationId: "telegram-42", prompt: "two", responseContent: "2" });
    await simulateTurn({ conversationId: "telegram-7", prompt: "other", responseContent: "x" });

    const historyFile = JSON.parse(fs.readFileSync(path.join(tmpDir, "agent-1.json"), "utf-8")) as {
      conversations: ConversationRecord[];
    };
    const ids = historyFile.conversations.map((conversation) => conversation.conversationId);
    expect(ids).toEqual(["telegram-7", "telegram-42"]);
  });

  it("different conversation ids stay isolated", async () => {
    await simulateTurn({
      conversationId: "telegram-42",
      prompt: "I like jazz",
      responseContent: "Cool!",
    });

    const otherChat = await runEffect(loadConversation("agent-1", "telegram-99", tmpDir));
    expect(otherChat).toBeNull();
  });

  it("prefers the runner's full transcript over the append fallback", async () => {
    const transcript: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    await simulateTurn({
      conversationId: "telegram-42",
      prompt: "hi",
      responseContent: "hello",
      responseMessages: transcript,
    });

    const saved = await runEffect(loadConversation("agent-1", "telegram-42", tmpDir));
    expect(saved?.messages).toEqual(transcript);
    expect(saved?.messageCount).toBe(3);
  });

  it("keeps the original title and startedAt across turns", async () => {
    await simulateTurn({
      conversationId: "telegram-42",
      prompt: "first message",
      responseContent: "ok",
    });
    const first = await runEffect(loadConversation("agent-1", "telegram-42", tmpDir));

    await simulateTurn({
      conversationId: "telegram-42",
      prompt: "second message",
      responseContent: "ok again",
    });
    const second = await runEffect(loadConversation("agent-1", "telegram-42", tmpDir));

    expect(second?.title).toBe("first message");
    expect(second?.startedAt).toBe(first?.startedAt ?? "");
  });

  it("conversation runs use the current JSON envelope shape", () => {
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

describe("composeResumedHistory", () => {
  const preamble = { role: "assistant" as const, content: "## Recovered context" };
  const record = {
    conversationId: "conv-1",
    messages: [{ role: "user" as const, content: "earlier turn" }],
  } as any;

  it("puts the recovered context ahead of persisted history", () => {
    const history = composeResumedHistory(record, preamble);
    expect(history?.[0]?.content).toBe("## Recovered context");
    expect(history?.[1]?.content).toBe("earlier turn");
  });

  it("resumes from working state alone after a killed run left no history", () => {
    // Regression: history is saved only when a run completes, so a killed run has no
    // prior record — the exact case the journal exists for. Gating on priorRecord made
    // it unreadable there.
    const history = composeResumedHistory(null, preamble);
    expect(history).toEqual([preamble]);
  });

  it("passes history through unchanged when there is no working state", () => {
    expect(composeResumedHistory(record, undefined)).toEqual(record.messages);
  });

  it("returns null when there is nothing to resume from at all", () => {
    expect(composeResumedHistory(null, undefined)).toBeNull();
  });
});
