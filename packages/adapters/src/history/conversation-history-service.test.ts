import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  createEgressTaint,
  taintedEgressNeedsApproval,
} from "@jazz/core/agent/execution/egress-taint";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@jazz/core/constants/agent";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { Effect } from "effect";
import {
  archiveLegacyHistory,
  ConversationChangedError,
  conversationRevision,
  EMPTY_CONVERSATION_REVISION,
  saveConversation,
  saveConversationOrFork,
  saveRunTranscript,
  loadConversation,
  loadHistory,
  setConversationRetentionLimit,
  type ConversationToSave,
  type ConversationsInUse,
} from "./conversation-history-service";
import { archivedConversationLogPath, conversationLogPath } from "./conversation-log";
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

function makeConversation(overrides: Partial<ConversationToSave> = {}): ConversationToSave {
  return {
    conversationId: "conv-1",
    title: "Hello world",
    agentId: "agent-1",
    startedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "Hello world" } as ChatMessage],
    basedOn: EMPTY_CONVERSATION_REVISION,
    ...overrides,
  };
}

describe("saveConversation", () => {
  test("retains egress approval when compaction rewrites and reloads a conversation", async () => {
    const beforeCompaction = await runEffect(
      saveConversation(
        makeConversation({
          messages: [
            { role: "user", content: "Research the vendor" },
            { role: "tool", content: "External page", egressTainted: true },
          ],
        }),
        tmpDir,
      ),
    );
    await runEffect(
      saveConversation(
        makeConversation({
          basedOn: beforeCompaction,
          messages: [
            {
              role: "assistant",
              kind: "summary",
              content: "Vendor report in progress",
              egressTainted: true,
            },
            { role: "user", content: "Continue" },
          ],
        }),
        tmpDir,
      ),
    );
    const restored = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(restored).not.toBeNull();
    expect(restored!.messages.some((message) => message.role === "tool")).toBe(false);
    expect(
      taintedEgressNeedsApproval({
        toolName: "read_pdf",
        egress: true,
        args: { url: "https://collector.example/?private=report" },
        policy: "read-only",
        taint: createEgressTaint(restored!.messages),
        messages: restored!.messages,
      }),
    ).toBe(true);
  });

  test("writes a log under the agent's own directory", async () => {
    await runEffect(saveConversation(makeConversation(), tmpDir));
    expect(fs.existsSync(conversationLogPath("agent-1", "conv-1", tmpDir))).toBe(true);
  });

  test("appends to the same log across turns instead of starting another", async () => {
    const first: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "1" },
    ];
    const afterFirst = await runEffect(
      saveConversation(makeConversation({ messages: first }), tmpDir),
    );
    await runEffect(
      saveConversation(
        makeConversation({
          messages: [...first, { role: "user", content: "two" }],
          basedOn: afterFirst,
        }),
        tmpDir,
      ),
    );

    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations).toHaveLength(1);
    expect(history.conversations[0]?.messageCount).toBe(3);
  });

  test("archives the oldest conversation instead of deleting it", async () => {
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
    const archived = gunzipSync(
      fs.readFileSync(archivedConversationLogPath("agent-1", "conv-0", tmpDir)),
    ).toString("utf-8");
    expect(archived).toContain('"conversationId":"conv-0"');
  });

  test("keeps one agent's conversations out of another's", async () => {
    await runEffect(saveConversation(makeConversation(), tmpDir));
    await runEffect(saveConversation(makeConversation({ agentId: "agent-2" }), tmpDir));

    expect((await runEffect(loadHistory("agent-1", tmpDir))).conversations).toHaveLength(1);
    expect((await runEffect(loadHistory("agent-2", tmpDir))).conversations).toHaveLength(1);
  });
});

describe("conversation retention", () => {
  const RETENTION_LIMIT = 3;
  const nothingInUse: ConversationsInUse = () => Effect.succeed(new Set<string>());

  beforeEach(() => {
    setConversationRetentionLimit(RETENTION_LIMIT);
  });

  afterEach(() => {
    setConversationRetentionLimit(undefined);
  });

  async function saveInOrder(count: number, conversationsInUse: ConversationsInUse) {
    for (let index = 0; index < count; index++) {
      const conversationId = `conv-${String(index)}`;
      await runEffect(
        saveConversation(makeConversation({ conversationId }), tmpDir, { conversationsInUse }),
      );
      const when = 1_700_000_000 + index;
      fs.utimesSync(conversationLogPath("agent-1", conversationId, tmpDir), when, when);
    }
  }

  test("keeps the configured number of conversations", async () => {
    await saveInOrder(5, nothingInUse);
    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations.map((conversation) => conversation.conversationId)).toEqual([
      "conv-4",
      "conv-3",
      "conv-2",
    ]);
  });

  test("never archives a conversation a goal, loop or run names", async () => {
    const goalConversation: ConversationsInUse = () => Effect.succeed(new Set(["conv-0"]));
    await saveInOrder(5, goalConversation);
    expect(fs.existsSync(conversationLogPath("agent-1", "conv-0", tmpDir))).toBe(true);
    expect(fs.existsSync(conversationLogPath("agent-1", "conv-1", tmpDir))).toBe(false);
    expect(fs.existsSync(archivedConversationLogPath("agent-1", "conv-1", tmpDir))).toBe(true);
  });

  test("a save without housekeeping archives nothing", async () => {
    for (let index = 0; index < 5; index++) {
      await runEffect(
        saveConversation(makeConversation({ conversationId: `conv-${String(index)}` }), tmpDir, {
          conversationsInUse: nothingInUse,
          housekeeping: false,
        }),
      );
    }
    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations).toHaveLength(5);
  });

  test("archives nothing when the goal, loop and run records cannot be read", async () => {
    const unreadable: ConversationsInUse = () => Effect.fail(new Error("goals unreadable"));
    await saveInOrder(5, unreadable);
    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations).toHaveLength(5);
  });

  test("moves files from the pre-directory history format into the archive once", async () => {
    const legacyIndex = path.join(tmpDir, "agent-1.json");
    const legacySessions = path.join(tmpDir, "sessions");
    fs.writeFileSync(legacyIndex, '{"agentId":"agent-1","conversations":[]}');
    fs.mkdirSync(legacySessions);
    fs.writeFileSync(path.join(legacySessions, "agent-1~conv-1.jsonl"), "{}\n");

    const moved = await runEffect(archiveLegacyHistory(tmpDir));

    expect(moved).toHaveLength(2);
    expect(fs.existsSync(legacyIndex)).toBe(false);
    expect(fs.existsSync(legacySessions)).toBe(false);
    const legacyArchive = path.join(tmpDir, "archive", "legacy");
    expect(fs.readFileSync(path.join(legacyArchive, "agent-1.json"), "utf-8")).toContain("agent-1");
    expect(fs.existsSync(path.join(legacyArchive, "sessions", "agent-1~conv-1.jsonl"))).toBe(true);
    expect(await runEffect(archiveLegacyHistory(tmpDir))).toEqual([]);
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

  test("concurrent writes to the same conversation save one and refuse the rest", async () => {
    const agentId = "agent-racer";
    const conversationId = "conv-racer";
    // Isolated callers that each started this conversation from nothing: the lock lets one
    // land, and every other one built on a log that no longer exists, so it is refused.
    const candidates: ChatMessage[][] = Array.from({ length: 6 }, (_, index) =>
      Array.from(
        { length: index + 1 },
        (_unused, turn) => ({ role: "user", content: `turn ${String(turn)}` }) as ChatMessage,
      ),
    );

    const outcomes = await runEffect(
      Effect.all(
        candidates.map((messages) =>
          saveConversation(makeConversation({ agentId, conversationId, messages }), tmpDir).pipe(
            Effect.either,
          ),
        ),
        { concurrency: 6 },
      ),
    );
    expect(outcomes.filter((outcome) => outcome._tag === "Right")).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome._tag === "Left") {
        expect(outcome.left).toBeInstanceOf(ConversationChangedError);
      }
    }

    // Whichever candidate the lock let land, the log must read back as exactly that
    // transcript — never a byte-level interleave of two writers' output.
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

  test("lists the conversation spoken in most recently first, however recently another was saved", async () => {
    try {
      setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
      const olderRevision = await runEffect(
        saveConversation(makeConversation({ conversationId: "older" }), tmpDir),
      );
      setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
      await runEffect(saveConversation(makeConversation({ conversationId: "newer" }), tmpDir));
      setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
      await runEffect(
        saveConversation(
          makeConversation({
            conversationId: "older",
            title: "Renamed, nothing said",
            basedOn: olderRevision,
          }),
          tmpDir,
        ),
      );
    } finally {
      setSystemTime();
    }

    const history = await runEffect(loadHistory("agent-1", tmpDir));
    expect(history.conversations.map((conversation) => conversation.conversationId)).toEqual([
      "newer",
      "older",
    ]);
    expect(history.conversations[0]?.lastMessageAt).toBe("2026-08-01T11:00:00.000Z");
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

describe("saving a run's transcript", () => {
  const priorMessages: ChatMessage[] = [{ role: "user", content: "Hello world" }];
  const runMessages: ChatMessage[] = [
    ...priorMessages,
    { role: "user", content: "check the deploy" },
    { role: "assistant", content: "deployed" },
  ];

  test("saves into the conversation the run loaded when nothing changed since", async () => {
    await runEffect(saveConversation(makeConversation({ messages: priorMessages }), tmpDir));
    const prior = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));

    const savedId = await runEffect(
      saveRunTranscript(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          prior,
          fallbackTitle: "goal",
          messages: runMessages,
        },
        tmpDir,
      ),
    );

    expect(savedId).toBe("conv-1");
    const saved = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(saved?.messages.map((message) => message.content)).toEqual(
      runMessages.map((message) => message.content),
    );
  });

  test("keeps the run in a new conversation when the one it loaded was saved elsewhere", async () => {
    const loadedRevision = await runEffect(
      saveConversation(makeConversation({ messages: priorMessages }), tmpDir),
    );
    const prior = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    await runEffect(
      saveConversation(
        makeConversation({
          messages: [
            ...priorMessages,
            { role: "assistant", content: "said in the chat meanwhile" },
          ],
          basedOn: loadedRevision,
        }),
        tmpDir,
      ),
    );
    const before = fs.readFileSync(conversationLogPath("agent-1", "conv-1", tmpDir), "utf8");

    const savedId = await runEffect(
      saveRunTranscript(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          prior,
          fallbackTitle: "goal",
          messages: runMessages,
        },
        tmpDir,
      ),
    );

    expect(savedId).not.toBe("conv-1");
    expect(fs.readFileSync(conversationLogPath("agent-1", "conv-1", tmpDir), "utf8")).toBe(before);
    const forked = await runEffect(loadConversation("agent-1", savedId, tmpDir));
    expect(forked?.messages.map((message) => message.content)).toEqual(
      runMessages.map((message) => message.content),
    );
    expect(forked?.title).toBe("Hello world");
  });

  test("saveConversationOrFork forks a writer that never read the conversation", async () => {
    await runEffect(saveConversation(makeConversation({ messages: priorMessages }), tmpDir));

    const savedId = await runEffect(
      saveConversationOrFork(makeConversation({ messages: runMessages }), tmpDir),
    );

    expect(savedId).not.toBe("conv-1");
    const original = await runEffect(loadConversation("agent-1", "conv-1", tmpDir));
    expect(original?.messages).toEqual(priorMessages);
  });

  test("saveConversationOrFork returns the original id for a save built on the current revision", async () => {
    await runEffect(saveConversation(makeConversation({ messages: priorMessages }), tmpDir));

    const savedId = await runEffect(
      saveConversationOrFork(
        makeConversation({
          messages: runMessages,
          basedOn: conversationRevision(priorMessages),
        }),
        tmpDir,
      ),
    );

    expect(savedId).toBe("conv-1");
  });
});
