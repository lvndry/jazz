import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  persistConversationIfNeeded,
  shouldPersistConversation,
  type PersistConversationInput,
} from "./persist-conversation";
import { loadConversation, loadHistory } from "../history/conversation-history-service";
import { resetConversationLogAppendCache } from "../history/conversation-log";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-persist-conversation-test-"));
  resetConversationLogAppendCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetConversationLogAppendCache();
});

function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeInput(overrides: Partial<PersistConversationInput> = {}): PersistConversationInput {
  return {
    ephemeral: false,
    conversationTitle: "Summarize yesterday's standup",
    conversationHistory: [
      { role: "user", content: "Summarize yesterday's standup" },
      { role: "assistant", content: "The team shipped the resume fix." },
    ] as ChatMessage[],
    conversationId: "conv-1",
    agentId: "agent-1",
    startedAt: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("shouldPersistConversation", () => {
  test("is true after the first titled turn", () => {
    expect(shouldPersistConversation(makeInput())).toBe(true);
  });

  test("is false for ephemeral sessions", () => {
    expect(shouldPersistConversation(makeInput({ ephemeral: true }))).toBe(false);
  });

  test("is false when the title has not been assigned yet", () => {
    expect(shouldPersistConversation(makeInput({ conversationTitle: null }))).toBe(false);
  });

  test("is false when history is empty", () => {
    expect(shouldPersistConversation(makeInput({ conversationHistory: [] }))).toBe(false);
  });
});

describe("persistConversationIfNeeded", () => {
  test("writes history so loadHistory returns the first-message title", async () => {
    const input = makeInput();
    await runEffect(persistConversationIfNeeded(input, tmpDir));

    const { conversations } = await runEffect(loadHistory(input.agentId, tmpDir));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("conv-1");
    expect(conversations[0]?.title).toBe("Summarize yesterday's standup");
    expect(conversations[0]?.messageCount).toBe(2);

    const loaded = await runEffect(loadConversation(input.agentId, "conv-1", tmpDir));
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "Summarize yesterday's standup",
      "The team shipped the resume fix.",
    ]);
  });

  test("does not write history for ephemeral sessions", async () => {
    const input = makeInput({ ephemeral: true });
    await runEffect(persistConversationIfNeeded(input, tmpDir));

    const { conversations } = await runEffect(loadHistory(input.agentId, tmpDir));
    expect(conversations).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, `${input.agentId}.json`))).toBe(false);
  });

  test("does not write history when the title is missing", async () => {
    await runEffect(persistConversationIfNeeded(makeInput({ conversationTitle: null }), tmpDir));

    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toEqual([]);
  });

  test("does not write history when the transcript is empty", async () => {
    await runEffect(persistConversationIfNeeded(makeInput({ conversationHistory: [] }), tmpDir));

    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toEqual([]);
  });

  test("later turns upsert the same conversationId with the latest transcript", async () => {
    const firstTurn = makeInput();
    await runEffect(persistConversationIfNeeded(firstTurn, tmpDir));

    const laterHistory: ChatMessage[] = [
      ...firstTurn.conversationHistory,
      { role: "user", content: "What about the blockers?" },
      { role: "assistant", content: "None remaining." },
    ];
    await runEffect(
      persistConversationIfNeeded(
        makeInput({
          conversationHistory: laterHistory,
        }),
        tmpDir,
      ),
    );

    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("conv-1");
    expect(conversations[0]?.title).toBe("Summarize yesterday's standup");
    expect(conversations[0]?.messageCount).toBe(4);

    const loaded = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "Summarize yesterday's standup",
      "The team shipped the resume fix.",
      "What about the blockers?",
      "None remaining.",
    ]);
  });
});
