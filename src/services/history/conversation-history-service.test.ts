import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  saveConversation,
  loadHistory,
  type ConversationRecord,
} from "./conversation-history-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-history-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  test("evicts oldest when count exceeds 5", async () => {
    for (let i = 1; i <= 6; i++) {
      await runEffect(saveConversation(makeRecord({ conversationId: `conv-${i}` }), tmpDir));
    }
    const { conversations } = await runEffect(loadHistory("agent-1", tmpDir));
    expect(conversations).toHaveLength(5);
    expect(conversations.map((c) => c.conversationId)).not.toContain("conv-1");
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
