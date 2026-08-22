import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@/core/constants/agent";
import type { ChatMessage } from "@/core/types/message";
import {
  saveConversation,
  loadConversation,
  loadHistory,
  type ConversationRecord,
} from "./conversation-history-service";
import { search } from "./session-search";
import { getSessionLogPath, makeSessionId, resetSessionAppendCache } from "./session-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-history-test-"));
  resetSessionAppendCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetSessionAppendCache();
});

function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationId: "conv-1",
    title: "Hello world",
    agentId: "agent-1",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    messageCount: 1,
    messages: [{ role: "user", content: "Hello world" } as ChatMessage],
    ...overrides,
  };
}

describe("saveConversation", () => {
  test("creates history directory and file when neither exists yet", async () => {
    const nonExistentDir = path.join(tmpDir, "nested", "history");
    const record = makeRecord();
    await runEffect(saveConversation(record, nonExistentDir));
    const historyPath = path.join(nonExistentDir, `${record.agentId}.json`);
    expect(fs.existsSync(historyPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    expect(data.conversations).toHaveLength(1);
  });

  test("creates history file on first save", async () => {
    const record = makeRecord();
    await runEffect(saveConversation(record, tmpDir));
    const historyPath = path.join(tmpDir, `${record.agentId}.json`);
    expect(fs.existsSync(historyPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].conversationId).toBe("conv-1");
  });

  test("prepends new conversation, newest first", async () => {
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-1" }), tmpDir));
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-2" }), tmpDir));
    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations[0].conversationId).toBe("conv-2");
    expect(conversations[1].conversationId).toBe("conv-1");
  });

  test("evicts oldest when count exceeds the cap", async () => {
    for (let i = 1; i <= MAX_CONVERSATION_HISTORY_PER_AGENT + 1; i++) {
      await runEffect(saveConversation(makeRecord({ conversationId: `conv-${i}` }), tmpDir));
    }
    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toHaveLength(MAX_CONVERSATION_HISTORY_PER_AGENT);
    expect(conversations.map((c) => c.conversationId)).not.toContain("conv-1");
  });

  test("saving an existing conversationId upserts and moves it to the front", async () => {
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-1" }), tmpDir));
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-2" }), tmpDir));
    await runEffect(
      saveConversation(makeRecord({ conversationId: "conv-1", title: "Updated" }), tmpDir),
    );
    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations.map((c) => c.conversationId)).toEqual(["conv-1", "conv-2"]);
    expect(conversations[0].title).toBe("Updated");
  });
});

describe("loadConversation", () => {
  test("returns the record matching the conversationId", async () => {
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-1" }), tmpDir));
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-2" }), tmpDir));
    const record = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(record?.conversationId).toBe("conv-1");
  });

  test("returns null when the conversation does not exist", async () => {
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-1" }), tmpDir));
    expect(await runEffect(loadConversation("agent-1", "conv-9", tmpDir))).toBeNull();
    expect(await runEffect(loadConversation("no-such-agent", "conv-1", tmpDir))).toBeNull();
  });
});

describe("loadHistory", () => {
  test("returns empty conversations array when file does not exist", async () => {
    const { conversations } = await runEffect(loadHistory("no-such-agent", tmpDir));
    expect(conversations).toEqual([]);
  });

  test("returns empty conversations array when file is corrupt", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "agent-1.json"), "not-json");
    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toEqual([]);
  });
});

describe("session-backed storage", () => {
  test("keeps the transcript in an append-only log, not in the index", async () => {
    const first = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ] as ChatMessage[];
    await runEffect(saveConversation(makeRecord({ messages: first, messageCount: 2 }), tmpDir));
    const sessionId = makeSessionId("agent-1", "conv-1");
    expect(fs.existsSync(getSessionLogPath(sessionId, tmpDir))).toBe(true);

    const indexPath = path.join(tmpDir, "agent-1.json");
    const indexAfterFirst = fs.readFileSync(indexPath, "utf-8");
    expect(JSON.parse(indexAfterFirst).conversations[0].messages).toEqual([]);

    const second = [...first, { role: "user", content: "three" }] as ChatMessage[];
    await runEffect(saveConversation(makeRecord({ messages: second, messageCount: 3 }), tmpDir));

    // The index does not grow with the transcript: that was the quadratic part.
    const indexAfterSecond = fs.readFileSync(indexPath, "utf-8");
    expect(indexAfterSecond.length).toBe(indexAfterFirst.length);

    const log = fs.readFileSync(getSessionLogPath(sessionId, tmpDir), "utf-8");
    expect(log.split("\n").filter((line) => line.includes('"type":"message"'))).toHaveLength(3);
  });

  test("loadConversation returns the transcript from the log", async () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ] as ChatMessage[];
    await runEffect(saveConversation(makeRecord({ messages, messageCount: 2 }), tmpDir));
    const loaded = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(loaded?.messages.map((message) => message.content)).toEqual(["one", "two"]);
    expect(loaded?.messageCount).toBe(2);
  });

  test("a deleted index is rebuilt from the session logs", async () => {
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-1" }), tmpDir));
    await runEffect(saveConversation(makeRecord({ conversationId: "conv-2" }), tmpDir));

    fs.rmSync(path.join(tmpDir, "agent-1.json"));

    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations.map((conversation) => conversation.conversationId).sort()).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(conversations[0]?.messages).toHaveLength(1);
  });

  test("evicting a conversation removes its log too", async () => {
    for (let index = 1; index <= MAX_CONVERSATION_HISTORY_PER_AGENT + 1; index++) {
      await runEffect(saveConversation(makeRecord({ conversationId: `conv-${index}` }), tmpDir));
    }
    expect(fs.existsSync(getSessionLogPath(makeSessionId("agent-1", "conv-1"), tmpDir))).toBe(
      false,
    );
  });

  test("conversations are searchable across sessions", async () => {
    await runEffect(
      saveConversation(
        makeRecord({
          conversationId: "conv-1",
          messages: [{ role: "user", content: "the Basel workshop dates" }] as ChatMessage[],
        }),
        tmpDir,
      ),
    );
    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits.map((hit) => hit.line)).toEqual(["the Basel workshop dates"]);
  });
});

describe("migration from pre-session-store history", () => {
  const legacyHistory = {
    agentId: "agent-1",
    conversations: [
      {
        conversationId: "legacy-1",
        title: "Old chat",
        agentId: "agent-1",
        startedAt: "2026-01-01T09:00:00.000Z",
        endedAt: "2026-01-01T09:30:00.000Z",
        messageCount: 2,
        messages: [
          { role: "user", content: "what did we decide about Basel?" },
          { role: "assistant", content: "the dates did not move" },
        ],
      },
    ],
  };

  function writeLegacyHistory() {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "agent-1.json"), JSON.stringify(legacyHistory, null, 2));
  }

  test("loading old history keeps every conversation and moves it into a log", async () => {
    writeLegacyHistory();

    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("Old chat");
    expect(conversations[0]?.startedAt).toBe("2026-01-01T09:00:00.000Z");
    expect(conversations[0]?.messages.map((message) => message.content)).toEqual([
      "what did we decide about Basel?",
      "the dates did not move",
    ]);
    expect(fs.existsSync(getSessionLogPath(makeSessionId("agent-1", "legacy-1"), tmpDir))).toBe(
      true,
    );
  });

  test("migrated conversations become searchable", async () => {
    writeLegacyHistory();
    await runEffect(loadHistory("agent-1", tmpDir));

    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionTitle).toBe("Old chat");
  });

  test("migration runs once and does not duplicate the transcript", async () => {
    writeLegacyHistory();
    await runEffect(loadHistory("agent-1", tmpDir));
    resetSessionAppendCache();
    await runEffect(loadHistory("agent-1", tmpDir));

    const log = fs.readFileSync(
      getSessionLogPath(makeSessionId("agent-1", "legacy-1"), tmpDir),
      "utf-8",
    );
    expect(log.split("\n").filter((line) => line.includes('"type":"message"'))).toHaveLength(2);
  });

  test("continuing a migrated conversation appends to its log", async () => {
    writeLegacyHistory();
    await runEffect(loadHistory("agent-1", tmpDir));

    const continued = [
      ...legacyHistory.conversations[0]!.messages,
      { role: "user", content: "and the flights?" },
    ] as ChatMessage[];
    await runEffect(
      saveConversation(
        makeRecord({
          conversationId: "legacy-1",
          title: "Old chat",
          messages: continued,
          messageCount: continued.length,
        }),
        tmpDir,
      ),
    );

    const loaded = await runEffect(loadConversation("agent-1", "legacy-1", tmpDir));
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "what did we decide about Basel?",
      "the dates did not move",
      "and the flights?",
    ]);
  });
});
