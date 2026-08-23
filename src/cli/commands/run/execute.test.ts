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
import { buildConversationRecord, composeResumedHistory } from "./execute";

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
