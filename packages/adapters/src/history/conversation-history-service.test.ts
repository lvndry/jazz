import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@jazz/core/constants/agent";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  saveConversation,
  loadConversation,
  loadHistory,
  type Conversation,
} from "./conversation-history-service";
import { conversationLogPath } from "./conversation-log";
import { search } from "./conversation-search";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-history-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function runEffectExit<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromiseExit(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: "conv-1",
    title: "Hello world",
    agentId: "agent-1",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "Hello world" } as ChatMessage],
    ...overrides,
  };
}

describe("saveConversation", () => {
  test("writes a log under the agent's own directory", async () => {
    await runEffect(saveConversation(makeConversation(), tmpDir));
    expect(fs.existsSync(conversationLogPath("agent-1", "conv-1", tmpDir))).toBe(true);
  });

  test("appends to the same log across turns instead of starting another", async () => {
    const first: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "1" },
    ];
    await runEffect(saveConversation(makeConversation({ messages: first }), tmpDir));
    await runEffect(
      saveConversation(
        makeConversation({ messages: [...first, { role: "user", content: "two" }] }),
        tmpDir,
      ),
    );

    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations).toHaveLength(1);
    expect(history.conversations[0]?.messageCount).toBe(3);
  });

  test("evicts the oldest conversation, and its log with it", async () => {
    for (let index = 0; index <= MAX_CONVERSATION_HISTORY_PER_AGENT; index++) {
      await runEffect(
        saveConversation(makeConversation({ conversationId: `conv-${String(index)}` }), tmpDir),
      );
      // Modification time is the eviction order, and a whole batch written inside one
      // millisecond would otherwise evict arbitrarily.
      const written = conversationLogPath("agent-1", `conv-${String(index)}`, tmpDir);
      const when = 1_700_000_000 + index;
      fs.utimesSync(written, when, when);
    }

    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations).toHaveLength(MAX_CONVERSATION_HISTORY_PER_AGENT);
    expect(fs.existsSync(conversationLogPath("agent-1", "conv-0", tmpDir))).toBe(false);
  });

  test("keeps one agent's conversations out of another's", async () => {
    await runEffect(saveConversation(makeConversation(), tmpDir));
    await runEffect(saveConversation(makeConversation({ agentId: "agent-2" }), tmpDir));

    expect((await runEffect(loadHistory("agent-1", tmpDir))).conversations).toHaveLength(1);
    expect((await runEffect(loadHistory("agent-2", tmpDir))).conversations).toHaveLength(1);
  });
});

describe("saveConversation under concurrency", () => {
  test("concurrent saves past the retention limit still evict down to the limit", async () => {
    const conversationIds = Array.from(
      { length: MAX_CONVERSATION_HISTORY_PER_AGENT + 10 },
      (_, index) => `conv-${String(index)}`,
    );

    await runEffect(
      Effect.all(
        conversationIds.map((conversationId) =>
          saveConversation(makeConversation({ conversationId }), tmpDir),
        ),
        { concurrency: 8 },
      ),
    );

    const history = await runEffect(loadHistory("agent-1", tmpDir));
    // Without the per-agent lock, concurrent append+list+evict transactions could each
    // list the directory before the others' writes landed, undercount how many
    // conversations exist, and leave more than the retention limit on disk.
    expect(history.conversations).toHaveLength(MAX_CONVERSATION_HISTORY_PER_AGENT);
  });

  test("concurrent writes to the same conversation never corrupt the log", async () => {
    const agentId = "agent-racer";
    const conversationId = "conv-racer";
    // Each candidate is a superset of the shorter ones, mimicking isolated callers that
    // resumed the same conversation and each observed a different amount of history.
    const candidates: ChatMessage[][] = Array.from({ length: 6 }, (_, index) =>
      Array.from(
        { length: index + 1 },
        (_unused, turn) => ({ role: "user", content: `turn ${String(turn)}` }) as ChatMessage,
      ),
    );

    await runEffect(
      Effect.all(
        candidates.map((messages) =>
          saveConversation(makeConversation({ agentId, conversationId, messages }), tmpDir),
        ),
        { concurrency: 6 },
      ),
    );

    // Whichever candidate's transaction the lock let land last, the log must read back as
    // exactly that transcript — never a byte-level interleave of two writers' output.
    const loaded = await runEffect(loadConversation(agentId, conversationId, tmpDir));
    expect(loaded).not.toBeNull();
    const finalContents = loaded?.messages.map((message) => message.content) ?? [];
    const matchesOneCandidate = candidates.some(
      (candidate) =>
        candidate.length === finalContents.length &&
        candidate.every((message, index) => message.content === finalContents[index]),
    );
    expect(matchesOneCandidate).toBe(true);

    const rawLines = fs
      .readFileSync(conversationLogPath(agentId, conversationId, tmpDir), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("a failed save releases its lock instead of blocking the next one", async () => {
    const brokenAgentId = "agent-broken";
    const brokenConversationsDir = path.join(tmpDir, "conversations", brokenAgentId);
    fs.mkdirSync(path.dirname(brokenConversationsDir), { recursive: true });
    // A file sits where the per-agent conversations directory needs to be created, so the
    // save fails partway through while still holding the lock.
    fs.writeFileSync(brokenConversationsDir, "not a directory");

    const failure = await runEffectExit(
      saveConversation(makeConversation({ agentId: brokenAgentId }), tmpDir),
    );
    expect(failure._tag).toBe("Failure");

    fs.rmSync(brokenConversationsDir);
    await runEffect(saveConversation(makeConversation({ agentId: brokenAgentId }), tmpDir));

    const history = await runEffect(loadHistory(brokenAgentId, tmpDir));
    expect(history.conversations).toHaveLength(1);
  });
});

describe("loadConversation", () => {
  test("returns the transcript that was saved", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "remember basel" },
      { role: "assistant", content: "noted" },
    ];
    await runEffect(saveConversation(makeConversation({ messages }), tmpDir));

    const loaded = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(loaded?.messages).toEqual(messages);
  });

  test("returns null for a conversation that was never saved", async () => {
    expect(await runEffect(loadConversation("agent-1", "nope", tmpDir))).toBeNull();
  });
});

describe("loadHistory", () => {
  test("returns nothing for an agent with no conversations", async () => {
    expect((await runEffect(loadHistory("agent-1", tmpDir))).conversations).toEqual([]);
  });

  test("returns summaries, which carry a count instead of the transcript", async () => {
    await runEffect(
      saveConversation(
        makeConversation({
          messages: [
            { role: "user", content: "one" },
            { role: "assistant", content: "two" },
          ],
        }),
        tmpDir,
      ),
    );

    const [summary] = (await runEffect(loadHistory("agent-1", tmpDir))).conversations;
    expect(summary?.messageCount).toBe(2);
    // Not "messages: []" — a listing cannot be mistaken for an empty conversation.
    expect(summary).not.toHaveProperty("messages");
  });

  test("survives a log that is not readable at all", async () => {
    await runEffect(saveConversation(makeConversation(), tmpDir));
    fs.writeFileSync(conversationLogPath("agent-1", "conv-1", tmpDir), "not json");

    expect((await runEffect(loadHistory("agent-1", tmpDir))).conversations).toEqual([]);
  });
});

describe("searching what was saved", () => {
  test("finds a conversation by its content", async () => {
    await runEffect(
      saveConversation(
        makeConversation({ messages: [{ role: "user", content: "the Basel workshop" }] }),
        tmpDir,
      ),
    );

    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversationId).toBe("conv-1");
    expect(hits[0]?.agentId).toBe("agent-1");
  });

  test("reaches every agent, not just one", async () => {
    await runEffect(
      saveConversation(
        makeConversation({ messages: [{ role: "user", content: "basel one" }] }),
        tmpDir,
      ),
    );
    await runEffect(
      saveConversation(
        makeConversation({
          agentId: "agent-2",
          conversationId: "conv-2",
          messages: [{ role: "user", content: "basel two" }],
        }),
        tmpDir,
      ),
    );

    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits.map((hit) => hit.agentId).sort()).toEqual(["agent-1", "agent-2"]);
  });
});
