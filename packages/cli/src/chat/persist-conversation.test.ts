import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { loadConversation, loadHistory } from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  persistConversationIfNeeded,
  shouldPersistConversation,
  type PersistConversationInput,
} from "./persist-conversation";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-persist-conversation-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeInput(overrides: Partial<PersistConversationInput> = {}): PersistConversationInput {
  return {
    ephemeral: false,
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
  test("is true once the user has said something", () => {
    expect(shouldPersistConversation(makeInput())).toBe(true);
  });

  test("is false for ephemeral sessions", () => {
    expect(shouldPersistConversation(makeInput({ ephemeral: true }))).toBe(false);
  });

  test("is false before the first user message", () => {
    expect(
      shouldPersistConversation(
        makeInput({ conversationHistory: [{ role: "system", content: "resuming" }] }),
      ),
    ).toBe(false);
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

  test("titles a resumed transcript by its first user message, not the newest one", async () => {
    const resumed = makeInput({
      conversationId: "conv-2",
      conversationHistory: [
        { role: "system", content: "Resuming conversation" },
        { role: "user", content: "How do I get the app viral?" },
        { role: "assistant", content: "Ship it." },
        { role: "user", content: "mv the plan to /tmp" },
      ] as ChatMessage[],
    });
    await runEffect(persistConversationIfNeeded(resumed, tmpDir));

    const { conversations } = await runEffect(loadHistory(resumed.agentId, tmpDir));
    expect(conversations[0]?.title).toBe("How do I get the app viral?");
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
