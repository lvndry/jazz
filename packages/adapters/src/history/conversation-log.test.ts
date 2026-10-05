/** Exercises append-only history, strict semantic UI recovery, and explicit version 2 migration. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { ChatMessage } from "@jazz/core/types/message";
import { presentationEntrySchema } from "@jazz/core/types/presentation-content-schema";
import { stateFileMode } from "@jazz/core/utils/private-mode";
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { Effect } from "effect";
import {
  collapseSupersededUiEvents,
  ConversationChangedError,
  conversationRevision,
  CONVERSATION_LOG_VERSION,
  EMPTY_CONVERSATION_REVISION,
  deleteConversationLog,
  deriveConversationTitle,
  displayConversationTitle,
  conversationLogPath,
  listConversationLogs,
  migratePresentationLog,
  parseConversationLog,
  parseConversationLogLine,
  readConversationLog,
  recordConversationTranscript,
  REAL_TITLES_FORMAT,
  reduceConversationLog,
  UNTITLED_CONVERSATION_TITLE,
} from "./conversation-log";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

function assistantMessage(content: string): ChatMessage {
  return { role: "assistant", content };
}

/** A first save of `messages`; a later save spreads this and names the revision it builds on. */
function record(messages: readonly ChatMessage[], title = "Trip planning") {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    title,
    startedAt: "2026-08-01T10:00:00.000Z",
    messages,
    basedOn: EMPTY_CONVERSATION_REVISION,
  };
}

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conv-1";

function logLines(agentId = AGENT_ID, conversationId = CONVERSATION_ID): string[] {
  const content = fs.readFileSync(conversationLogPath(agentId, conversationId, tmpDir), "utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

function messageLineCount(agentId = AGENT_ID, conversationId = CONVERSATION_ID): number {
  return logLines(agentId, conversationId).filter((line) => line.includes('"type":"message"'))
    .length;
}

describe("recordConversationTranscript", () => {
  test("writes a header and one line per message", async () => {
    await runEffect(
      recordConversationTranscript(record([userMessage("hi"), assistantMessage("hello")]), tmpDir),
    );
    const lines = logLines();
    expect(lines[0]).toContain('"type":"conversation"');
    expect(messageLineCount()).toBe(2);
  });

  test("never records the system prompt, which is rebuilt on every run", async () => {
    await runEffect(
      recordConversationTranscript(
        record([
          { role: "system", content: "You are helpful." },
          userMessage("hi"),
          assistantMessage("hello"),
        ]),
        tmpDir,
      ),
    );

    expect(messageLineCount()).toBe(2);
    const conversation = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("appends only the new messages instead of rewriting the log", async () => {
    const first = [userMessage("hi"), assistantMessage("hello")];
    const afterFirst = await runEffect(recordConversationTranscript(record(first), tmpDir));
    const bytesAfterFirst = fs.statSync(
      conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir),
    ).size;

    const second = [...first, userMessage("and again"), assistantMessage("sure")];
    await runEffect(
      recordConversationTranscript({ ...record(second), basedOn: afterFirst }, tmpDir),
    );

    const content = fs.readFileSync(
      conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir),
      "utf-8",
    );
    expect(messageLineCount()).toBe(4);
    // The original bytes are still the prefix of the file: nothing was rewritten.
    expect(content.length).toBeGreaterThan(bytesAfterFirst);
    expect(content.indexOf('"hello"')).toBeLessThan(content.indexOf('"and again"'));
  });

  test("counts existing messages from disk on every append", async () => {
    const first = [userMessage("hi"), assistantMessage("hello")];
    await runEffect(recordConversationTranscript(record(first), tmpDir));

    await runEffect(
      recordConversationTranscript(
        { ...record([...first, userMessage("resumed")]), basedOn: conversationRevision(first) },
        tmpDir,
      ),
    );

    expect(messageLineCount()).toBe(3);
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual(["hi", "hello", "resumed"]);
  });

  test("a replaced transcript supersedes the old one instead of concatenating", async () => {
    const original = [userMessage("hi"), assistantMessage("hello"), userMessage("more")];
    const afterOriginal = await runEffect(recordConversationTranscript(record(original), tmpDir));

    const compacted: ChatMessage[] = [
      { role: "assistant", content: "summary of earlier turns", kind: "summary" },
      userMessage("carry on"),
    ];
    await runEffect(
      recordConversationTranscript({ ...record(compacted), basedOn: afterOriginal }, tmpDir),
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual([
      "summary of earlier turns",
      "carry on",
    ]);
    // The superseded lines are still on disk — search can still reach them.
    expect(messageLineCount()).toBe(5);
  });

  test("tolerates a truncated final line and keeps appending cleanly", async () => {
    const beforeCrash = await runEffect(
      recordConversationTranscript(record([userMessage("hi"), assistantMessage("hello")]), tmpDir),
    );

    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.appendFileSync(logPath, '{"type":"message","at":"2026-08-01T10:0');

    const afterCrash = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(afterCrash?.messages.map((message) => message.content)).toEqual(["hi", "hello"]);

    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi"), assistantMessage("hello"), userMessage("after the crash")]),
          basedOn: beforeCrash,
        },
        tmpDir,
      ),
    );

    const recovered = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(recovered?.messages.map((message) => message.content)).toEqual([
      "hi",
      "hello",
      "after the crash",
    ]);
  });

  test("titles an untitled conversation by what was typed, without the memory-source tag", async () => {
    const tagged: ChatMessage = {
      role: "user",
      content: "plan the trip\n\n[memory source user:abc]",
      memorySource: { id: "user:abc", text: "plan the trip" },
    };
    await runEffect(recordConversationTranscript(record([tagged], ""), tmpDir));

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.title).toBe("plan the trip");
  });

  test("a save built on a stale revision is refused and writes nothing", async () => {
    const first = [userMessage("hi")];
    const afterFirst = await runEffect(recordConversationTranscript(record(first), tmpDir));
    await runEffect(
      recordConversationTranscript(
        { ...record([...first, assistantMessage("hello")]), basedOn: afterFirst },
        tmpDir,
      ),
    );
    const before = fs.readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf8");

    const stale = await runEffect(
      recordConversationTranscript(
        { ...record([...first, userMessage("from a stale copy")]), basedOn: afterFirst },
        tmpDir,
      ).pipe(Effect.either),
    );

    expect(stale._tag === "Left" && stale.left instanceof ConversationChangedError).toBe(true);
    expect(fs.readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf8")).toBe(
      before,
    );
  });

  test("a writer that never read the log cannot replace what was said in it", async () => {
    await runEffect(
      recordConversationTranscript(
        record([userMessage("plan the trip"), assistantMessage("Where to?")]),
        tmpDir,
      ),
    );
    const before = fs.readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf8");

    for (const unread of [[], [userMessage("a different conversation")]]) {
      const refused = await runEffect(
        recordConversationTranscript(record(unread), tmpDir).pipe(Effect.either),
      );
      expect(refused._tag === "Left" && refused.left instanceof ConversationChangedError).toBe(
        true,
      );
    }
    expect(fs.readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf8")).toBe(
      before,
    );
  });

  test("a writer that read the log may replace it, as compaction does", async () => {
    const original = [userMessage("hi"), assistantMessage("hello"), userMessage("more")];
    const afterOriginal = await runEffect(recordConversationTranscript(record(original), tmpDir));
    const compacted: ChatMessage[] = [
      { role: "assistant", content: "summary", kind: "summary" },
      userMessage("carry on"),
    ];

    const afterCompaction = await runEffect(
      recordConversationTranscript({ ...record(compacted), basedOn: afterOriginal }, tmpDir),
    );

    expect(afterCompaction).toEqual(conversationRevision(compacted));
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages).toEqual(compacted);
  });

  test("of two writers building on the same revision, only the first is saved", async () => {
    const first = [userMessage("hi")];
    const shared = await runEffect(recordConversationTranscript(record(first), tmpDir));

    await runEffect(
      recordConversationTranscript(
        { ...record([...first, assistantMessage("from the chat")]), basedOn: shared },
        tmpDir,
      ),
    );
    const second = await runEffect(
      recordConversationTranscript(
        { ...record([...first, assistantMessage("from a goal cycle")]), basedOn: shared },
        tmpDir,
      ).pipe(Effect.either),
    );

    expect(second._tag === "Left" && second.left instanceof ConversationChangedError).toBe(true);
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual(["hi", "from the chat"]);
  });

  test("a conversation with nothing to name it by has no title, and records none", async () => {
    await runEffect(recordConversationTranscript(record([], ""), tmpDir));
    expect(
      (await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir)))?.title,
    ).toBeUndefined();

    await runEffect(
      recordConversationTranscript(record([userMessage("book the flights")], ""), tmpDir),
    );
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.title).toBe("book the flights");
    const content = fs.readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf8");
    expect(content).not.toContain(UNTITLED_CONVERSATION_TITLE);
  });

  /** The regression: the placeholder's text was reserved, so a rename to it never stuck. */
  test("a conversation can be titled with the placeholder's text", async () => {
    await runEffect(
      recordConversationTranscript(
        record([userMessage("plan the trip")], UNTITLED_CONVERSATION_TITLE),
        tmpDir,
      ),
    );
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.title).toBe(UNTITLED_CONVERSATION_TITLE);
  });

  test("a log from before real titles drops its stored placeholders on the next save", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "conversation",
          version: CONVERSATION_LOG_VERSION,
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          startedAt: "2026-08-01T10:00:00.000Z",
          title: UNTITLED_CONVERSATION_TITLE,
        }),
        JSON.stringify({
          type: "message",
          at: "2026-08-01T10:00:01.000Z",
          message: userMessage("plan the trip"),
        }),
        JSON.stringify({
          type: "meta",
          at: "2026-08-01T10:00:02.000Z",
          title: UNTITLED_CONVERSATION_TITLE,
        }),
        "",
      ].join("\n"),
    );
    const legacy = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(legacy?.title).toBe("plan the trip");

    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("plan the trip")], UNTITLED_CONVERSATION_TITLE),
          basedOn: conversationRevision([userMessage("plan the trip")]),
        },
        tmpDir,
      ),
    );
    const content = fs.readFileSync(logPath, "utf8");
    expect(JSON.parse(content.split("\n")[0] ?? "{}")).toMatchObject({
      titleFormat: REAL_TITLES_FORMAT,
    });
    expect(JSON.parse(content.split("\n")[0] ?? "{}").title).toBeUndefined();
    const renamed = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(renamed?.title).toBe(UNTITLED_CONVERSATION_TITLE);
  });

  /**
   * The regression: an empty snapshot read the same as none, so resuming after `/clear`
   * repainted the cleared scrollback from the messages.
   */
  test("tells a conversation that never saved scrollback from one that saved it empty", () => {
    const header = {
      type: "conversation" as const,
      version: CONVERSATION_LOG_VERSION,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      startedAt: "2026-08-01T10:00:00.000Z",
    };
    const message = {
      type: "message" as const,
      at: "2026-08-01T10:00:01.000Z",
      message: userMessage("plan the trip"),
    };
    expect(reduceConversationLog([header, message])?.uiTranscript).toBeUndefined();
    expect(
      reduceConversationLog([
        header,
        message,
        { type: "ui-transcript", at: "2026-08-01T10:00:02.000Z", entries: [] },
      ])?.uiTranscript,
    ).toEqual([]);
  });

  test("a recorded untitled placeholder does not hide the title before it", () => {
    const conversation = reduceConversationLog([
      {
        type: "conversation",
        version: CONVERSATION_LOG_VERSION,
        agentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
        startedAt: "2026-08-01T10:00:00.000Z",
      },
      { type: "message", at: "2026-08-01T10:00:01.000Z", message: userMessage("plan the trip") },
      { type: "meta", at: "2026-08-01T10:00:02.000Z", title: "Trip planning" },
      { type: "meta", at: "2026-08-02T10:00:00.000Z", title: "untitled conversation" },
    ]);
    expect(conversation?.title).toBe("Trip planning");
  });

  test("records a title change as metadata", async () => {
    const afterFirst = await runEffect(
      recordConversationTranscript(record([userMessage("hi")], "First title"), tmpDir),
    );
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("hi")], "Second title"), basedOn: afterFirst },
        tmpDir,
      ),
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.title).toBe("Second title");
  });

  test("dates the conversation by its newest message, not by a later save that adds none", async () => {
    try {
      setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
      const afterHi = await runEffect(
        recordConversationTranscript(record([userMessage("hi")]), tmpDir),
      );
      setSystemTime(new Date("2026-08-01T11:00:00.000Z"));
      await runEffect(
        recordConversationTranscript({ ...record([userMessage("hi")]), basedOn: afterHi }, tmpDir),
      );
      const unchanged = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
      expect(unchanged?.lastMessageAt).toBe("2026-08-01T10:00:00.000Z");

      setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
      await runEffect(
        recordConversationTranscript(
          { ...record([userMessage("hi"), assistantMessage("hello")]), basedOn: afterHi },
          tmpDir,
        ),
      );
      const answered = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
      expect(answered?.lastMessageAt).toBe("2026-08-01T12:00:00.000Z");
    } finally {
      setSystemTime();
    }
  });
  test("ignores the save time older meta events carry", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "conversation",
          version: CONVERSATION_LOG_VERSION,
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          startedAt: "2026-08-01T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          at: "2026-08-01T10:00:01.000Z",
          message: userMessage("hi"),
        }),
        JSON.stringify({
          type: "meta",
          at: "2026-08-01T11:00:00.000Z",
          endedAt: "2026-08-01T11:00:00.000Z",
        }),
        "",
      ].join("\n"),
      { mode: stateFileMode() },
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.lastMessageAt).toBe("2026-08-01T10:00:01.000Z");
  });

  test("preserves the started-at instant across appends", async () => {
    const afterHi = await runEffect(
      recordConversationTranscript(record([userMessage("hi")]), tmpDir),
    );
    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi"), userMessage("two")]),
          startedAt: "2027-01-01T00:00:00.000Z",
          basedOn: afterHi,
        },
        tmpDir,
      ),
    );
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.startedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  test("persists a UI-only transcript without adding it to model messages", async () => {
    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi")]),
          uiTranscript: [
            {
              id: "/info",
              timestamp: "2026-08-01T10:00:00.000Z",
              content: { kind: "user" as const, text: "/info" },
            },
            {
              id: "Conversation info",
              timestamp: "2026-08-01T10:00:00.000Z",
              content: { kind: "notice" as const, tone: "log" as const, text: "Conversation info" },
            },
          ],
        },
        tmpDir,
      ),
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages).toEqual([userMessage("hi")]);
    expect(session?.uiTranscript).toEqual([
      {
        id: "/info",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "user" as const, text: "/info" },
      },
      {
        id: "Conversation info",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "notice" as const, tone: "log" as const, text: "Conversation info" },
      },
    ]);
  });
});

describe("UI scrollback growth", () => {
  const TURN_PADDING = " ".repeat(200);
  const ANSWER_PADDING = "x".repeat(800);

  /** One chat turn: about a kilobyte of messages and the same again of scrollback. */
  function turnsOfChat(turns: number) {
    const messages: ChatMessage[] = [];
    const uiTranscript: import("@jazz/core/types/presentation-content").PresentationEntry[] = [];
    for (let turn = 0; turn < turns; turn++) {
      messages.push(userMessage(`question ${turn}${TURN_PADDING}`));
      messages.push(assistantMessage(`answer ${turn}${ANSWER_PADDING}`));
      uiTranscript.push({
        id: `question:${turn}`,
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "user" as const, text: `question ${turn}${TURN_PADDING}` },
      });
      uiTranscript.push({
        id: `answer:${turn}`,
        timestamp: "2026-08-01T10:00:00.000Z",
        content: {
          kind: "notice" as const,
          tone: "info" as const,
          text: `answer ${turn}${ANSWER_PADDING}`,
        },
      });
    }
    return { messages, uiTranscript };
  }

  test("a log grows linearly with the turns of a chat that saves every turn", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    const sizes = new Map<number, number>();
    const { messages, uiTranscript } = turnsOfChat(200);
    let revision = EMPTY_CONVERSATION_REVISION;
    for (let turn = 1; turn <= 200; turn++) {
      revision = await runEffect(
        recordConversationTranscript(
          {
            ...record(messages.slice(0, turn * 2)),
            uiTranscript: uiTranscript.slice(0, turn * 2),
            basedOn: revision,
          },
          tmpDir,
        ),
      );
      if (turn % 50 === 0) {
        sizes.set(turn, fs.statSync(logPath).size);
      }
    }

    const at100 = sizes.get(100) ?? 0;
    const at200 = sizes.get(200) ?? 0;
    // Twice the turns is twice the bytes, give or take the header; every snapshot appended
    // whole would make it four times.
    expect(at200 / at100).toBeLessThan(2.1);
    // About 2KB of content per turn (messages plus their scrollback lines).
    expect(at200).toBeLessThan(200 * 2_600);

    const loaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(loaded?.uiTranscript).toEqual(uiTranscript);
    expect(loaded?.messages).toEqual(messages);
  });

  test("appends new scrollback entries and snapshots a scrollback that was cleared", async () => {
    const first = [
      {
        id: "hi",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "user" as const, text: "hi" },
      },
    ];
    const second = [
      ...first,
      {
        id: "hello",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "notice" as const, tone: "info" as const, text: "hello" },
      },
    ];
    const cleared = [
      {
        id: "fresh start",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "notice" as const, tone: "info" as const, text: "fresh start" },
      },
    ];
    let revision = EMPTY_CONVERSATION_REVISION;
    for (const uiTranscript of [first, second, cleared]) {
      revision = await runEffect(
        recordConversationTranscript(
          { ...record([userMessage("hi")]), uiTranscript, basedOn: revision },
          tmpDir,
        ),
      );
    }

    const uiLines = logLines().filter((line) => line.includes('"type":"ui-'));
    expect(uiLines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      "ui-append",
      "ui-append",
      "ui-transcript",
    ]);
    const loaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(loaded?.uiTranscript).toEqual(cleared);
  });

  test("an unchanged scrollback appends nothing", async () => {
    const uiTranscript = [
      {
        id: "hi",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "user" as const, text: "hi" },
      },
    ];
    const afterHi = await runEffect(
      recordConversationTranscript({ ...record([userMessage("hi")]), uiTranscript }, tmpDir),
    );
    const before = logLines().length;
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("hi")]), uiTranscript, basedOn: afterHi },
        tmpDir,
      ),
    );
    expect(logLines().length).toBe(before);
  });

  test("the first save collapses snapshots an older Jazz appended whole on every save", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const header = JSON.stringify({
      type: "conversation",
      version: 2,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      startedAt: "2026-08-01T10:00:00.000Z",
      title: "Trip planning",
    });
    const snapshots = [1, 2, 3].map((count) =>
      JSON.stringify({
        type: "ui-transcript",
        at: "2026-08-01T10:00:00.000Z",
        entries: Array.from({ length: count }, (_unused, index) => ({
          type: "user",
          message: `line ${index}`,
        })),
      }),
    );
    const message = JSON.stringify({
      type: "message",
      at: "2026-08-01T10:00:00.000Z",
      message: userMessage("hi"),
    });
    fs.writeFileSync(logPath, [header, message, ...snapshots, ""].join("\n"));

    const legacy = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(legacy?.uiTranscript?.length).toBe(3);

    const nextScrollback = [
      ...(legacy?.uiTranscript ?? []),
      {
        id: "more",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: { kind: "notice" as const, tone: "info" as const, text: "more" },
      },
    ];
    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi")]),
          uiTranscript: nextScrollback,
          basedOn: conversationRevision(legacy?.messages ?? []),
        },
        tmpDir,
      ),
    );

    const types = logLines().map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["conversation", "message", "ui-transcript", "ui-append"]);
    const loaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(loaded?.uiTranscript).toEqual(nextScrollback);
    expect(loaded?.messages).toEqual([userMessage("hi")]);
  });

  test("collapsing keeps every non-UI line, unreadable ones included", () => {
    const header = JSON.stringify({
      type: "conversation",
      version: 2,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      startedAt: "2026-08-01T10:00:00.000Z",
    });
    const content = [
      header,
      '{"type":"ui-transcript","at":"t","entries":[]}',
      "not json",
      '{"type":"ui-append","at":"t","entries":[]}',
      '{"type":"ui-transcript","at":"t","entries":[{"type":"user","message":"x"}]}',
      "",
    ].join("\n");
    expect(collapseSupersededUiEvents(content)).toBe(
      [
        header,
        "not json",
        '{"type":"ui-transcript","at":"t","entries":[{"type":"user","message":"x"}]}',
        "",
      ].join("\n"),
    );
    expect(
      collapseSupersededUiEvents('{"type":"ui-transcript","at":"t","entries":[]}\n'),
    ).toBeNull();
  });

  test("a save after another process appended reads the log again", async () => {
    await runEffect(recordConversationTranscript(record([userMessage("hi")]), tmpDir));
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ type: "message", at: "2026-08-01T10:00:00.000Z", message: assistantMessage("from elsewhere") })}\n`,
    );

    const onDisk = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi"), assistantMessage("from elsewhere"), userMessage("next")]),
          basedOn: conversationRevision(onDisk?.messages ?? []),
        },
        tmpDir,
      ),
    );

    const loaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(loaded?.messages.map((entry) => entry.content)).toEqual([
      "hi",
      "from elsewhere",
      "next",
    ]);
    expect(messageLineCount()).toBe(3);
  });
});

describe("readConversationLog", () => {
  test("returns null for a conversation that was never written", async () => {
    expect(await runEffect(readConversationLog("agent-1", "nope", tmpDir))).toBeNull();
  });

  test("returns null when the log has no readable header", async () => {
    const logPath = conversationLogPath("agent-1", "broken", tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "not json at all\n");
    expect(await runEffect(readConversationLog("agent-1", "broken", tmpDir))).toBeNull();
  });
});

describe("listConversationLogs", () => {
  test("lists newest first and filters by agent", async () => {
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("one")]), conversationId: "conv-1" },
        tmpDir,
      ),
    );
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("two")]), conversationId: "conv-2" },
        tmpDir,
      ),
    );
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("other")]), agentId: "agent-2", conversationId: "conv-3" },
        tmpDir,
      ),
    );

    const forAgentOne = await runEffect(listConversationLogs("agent-1", tmpDir));
    expect(forAgentOne.map((log) => log.conversationId).sort()).toEqual(["conv-1", "conv-2"]);
    // Another agent's conversations live in their own directory, so listing one agent can
    // never reach them.
    const forAgentTwo = await runEffect(listConversationLogs("agent-2", tmpDir));
    expect(forAgentTwo.map((log) => log.conversationId)).toEqual(["conv-3"]);
  });

  test("returns nothing when no conversation has been written", async () => {
    expect(await runEffect(listConversationLogs("agent-1", tmpDir))).toEqual([]);
  });
});

describe("deleteConversationLog", () => {
  test("removes the log and is safe to repeat", async () => {
    await runEffect(recordConversationTranscript(record([userMessage("hi")]), tmpDir));
    await runEffect(deleteConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(fs.existsSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir))).toBe(false);
    await runEffect(deleteConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
  });

  test("a session written again after deletion is readable", async () => {
    const messages = [userMessage("hi"), assistantMessage("hello")];
    await runEffect(recordConversationTranscript(record(messages), tmpDir));
    await runEffect(deleteConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));

    await runEffect(recordConversationTranscript(record(messages), tmpDir));

    const reread = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(reread).not.toBeNull();
    expect(reread?.messages).toHaveLength(2);
    expect(reread?.title).toBe("Trip planning");
    expect(messageLineCount()).toBe(2);
  });
});

describe("parseConversationLogLine", () => {
  test("rejects blank, non-JSON, and unknown lines", () => {
    expect(parseConversationLogLine("")).toBeNull();
    expect(parseConversationLogLine("{oops")).toBeNull();
    expect(parseConversationLogLine('{"type":"nonsense"}')).toBeNull();
    expect(
      parseConversationLogLine('{"type":"message","message":{"role":"ghost","content":"x"}}'),
    ).toBeNull();
  });

  test("reads a message event", () => {
    const event = parseConversationLogLine(
      '{"type":"message","at":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
    );
    expect(event).toEqual({
      type: "message",
      at: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "hi" },
    });
  });

  test("legacy decoding requires an explicit version 2 context and preserves record identity", () => {
    const line = JSON.stringify({
      type: "ui-transcript",
      at: "2026-08-01T10:00:00.000Z",
      entries: [{ type: "user", message: "old question" }],
    });
    expect(parseConversationLogLine(line)).toBeNull();
    expect(parseConversationLogLine(line, 7, 1)).toBeNull();
    expect(parseConversationLogLine(line, 7, 3)).toBeNull();
    expect(parseConversationLogLine(line, 7, 2)).toEqual({
      type: "ui-transcript",
      at: "2026-08-01T10:00:00.000Z",
      entries: [
        {
          id: "legacy:7:0",
          timestamp: "2026-08-01T10:00:00.000Z",
          content: { kind: "user", text: "old question" },
        },
      ],
    });
  });

  test("legacy timestamps become schema-valid ISO instants", () => {
    for (const [at, timestamp] of [
      ["2026-01-01", "2026-01-01T00:00:00.000Z"],
      ["2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.000Z"],
      ["unreadable date", "1970-01-01T00:00:00.000Z"],
    ] as const) {
      const event = parseConversationLogLine(
        JSON.stringify({
          type: "ui-transcript",
          at,
          entries: [{ type: "user", message: "old question" }],
        }),
        7,
        2,
      );
      expect(event?.type).toBe("ui-transcript");
      if (event?.type !== "ui-transcript") throw new Error("Legacy UI event expected");
      expect(event.entries[0]?.timestamp).toBe(timestamp);
      expect(presentationEntrySchema.safeParse(event.entries[0]).success).toBe(true);
    }
  });
});

describe("deriveConversationTitle", () => {
  test("prefers an explicit title", () => {
    expect(deriveConversationTitle("Trip planning", [userMessage("hello")])).toBe("Trip planning");
  });

  test("falls back to the first user message on one line", () => {
    expect(
      deriveConversationTitle("  ", [assistantMessage("hi"), userMessage("book\n the flights")]),
    ).toBe("book the flights");
  });

  test("has no title for a conversation with nothing to name it by; the screen shows one", () => {
    expect(deriveConversationTitle(undefined, [])).toBeUndefined();
    expect(displayConversationTitle(undefined)).toBe(UNTITLED_CONVERSATION_TITLE);
    expect(displayConversationTitle("Trip planning")).toBe("Trip planning");
  });
});

describe("conversation log privacy and versions", () => {
  test("creates the log and its directory private to the owner", async () => {
    await runEffect(recordConversationTranscript(record([userMessage("hi")]), tmpDir));
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(logPath)).mode & 0o777).toBe(0o700);
  });

  test("refuses to read or append to a log written by a newer Jazz", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const newer = `${JSON.stringify({
      type: "conversation",
      version: 99,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      startedAt: "2026-08-01T10:00:00.000Z",
    })}\n`;
    fs.writeFileSync(logPath, newer);

    const read = await runEffect(
      readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir).pipe(Effect.either),
    );
    expect(read._tag).toBe("Left");
    const append = await runEffect(
      recordConversationTranscript(record([userMessage("hi")]), tmpDir).pipe(Effect.either),
    );
    expect(append._tag).toBe("Left");
    expect(fs.readFileSync(logPath, "utf8")).toBe(newer);
  });
});

describe("semantic presentation persistence", () => {
  const timestamp = "2026-10-01T10:00:00.000Z";
  const receipt = {
    id: "receipt",
    timestamp,
    content: {
      kind: "tool" as const,
      receipt: { app: "read_file", summary: "README.md", status: "ok" as const },
    },
  };
  const answer = {
    id: "answer",
    timestamp,
    content: { kind: "agent" as const, markdown: "**answer**" },
  };

  function boundaryHistory(...events: readonly unknown[]) {
    return reduceConversationLog(
      parseConversationLog(
        [
          {
            type: "conversation",
            version: 3,
            agentId: AGENT_ID,
            conversationId: CONVERSATION_ID,
            startedAt: timestamp,
          },
          { type: "message", at: timestamp, message: userMessage("model-facing text") },
          { type: "ui-transcript", at: timestamp, entries: [receipt] },
          ...events,
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      ),
    );
  }

  test("rejects a whole snapshot with duplicate source IDs and preserves valid history", () => {
    const history = boundaryHistory({
      type: "ui-transcript",
      at: timestamp,
      entries: [answer, answer],
    });
    expect(history?.uiTranscript).toEqual([receipt]);
    expect(history?.messages).toEqual([userMessage("model-facing text")]);
  });

  test("rejects a whole append that republishes an existing source ID", () => {
    const history = boundaryHistory({
      type: "ui-append",
      at: timestamp,
      entries: [answer, receipt],
    });
    expect(history?.uiTranscript).toEqual([receipt]);
    expect(history?.messages).toEqual([userMessage("model-facing text")]);
  });

  test("rejects duplicate IDs within an append without reserving IDs from the rejected batch", () => {
    const history = boundaryHistory(
      { type: "ui-append", at: timestamp, entries: [answer, answer] },
      { type: "ui-append", at: timestamp, entries: [answer] },
    );
    expect(history?.uiTranscript).toEqual([receipt, answer]);
  });

  test("a malformed entry rejects its whole UI batch without losing later model messages", () => {
    for (const type of ["ui-transcript", "ui-append"]) {
      const history = boundaryHistory(
        {
          type,
          at: timestamp,
          entries: [
            answer,
            {
              ...answer,
              id: "invalid",
              content: { ...answer.content, viewport: 12 },
            },
          ],
        },
        { type: "message", at: timestamp, message: assistantMessage("still model-facing") },
        { type: "ui-append", at: timestamp, entries: [answer] },
      );
      expect(history?.uiTranscript).toEqual([receipt, answer]);
      expect(history?.messages).toEqual([
        userMessage("model-facing text"),
        assistantMessage("still model-facing"),
      ]);
    }
  });

  test("does not reinterpret malformed semantic facts as legacy text", () => {
    const history = boundaryHistory({
      type: "ui-transcript",
      at: timestamp,
      entries: [{ ...answer, type: "user", message: "invented legacy text" }],
    });
    expect(history?.uiTranscript).toEqual([receipt]);
    expect(
      parseConversationLogLine(
        JSON.stringify({
          type: "ui-transcript",
          at: timestamp,
          entries: [{ ...answer, type: "user", message: "invented legacy text" }],
        }),
        3,
        2,
      ),
    ).toBeNull();
  });

  test("a version 3 header refuses legacy text records", () => {
    const history = boundaryHistory({
      type: "ui-transcript",
      at: timestamp,
      entries: [{ type: "user", message: "legacy under version 3" }],
    });
    expect(history?.uiTranscript).toEqual([receipt]);
  });

  test("an earlier fact change replaces the snapshot even when the last entry is unchanged", async () => {
    await runEffect(
      recordConversationTranscript({ ...record([]), uiTranscript: [receipt, answer] }, tmpDir),
    );
    const changed = {
      ...receipt,
      content: { kind: "tool" as const, receipt: { ...receipt.content.receipt, durationMs: 12 } },
    };
    await runEffect(
      recordConversationTranscript({ ...record([]), uiTranscript: [changed, answer] }, tmpDir),
    );
    expect(logLines().map((line) => JSON.parse(line).type)).toEqual([
      "conversation",
      "ui-append",
      "ui-transcript",
    ]);
    expect(
      (await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir)))?.uiTranscript,
    ).toEqual([changed, answer]);
  });

  test("receipt facts and throughput survive a save/read cycle", async () => {
    const stats = {
      id: "stats",
      timestamp,
      content: {
        kind: "turn-receipt" as const,
        steps: [
          {
            durationMs: 500,
            generationDurationMs: 400,
            completionTokens: 40,
            tokensPerSecond: 100,
          },
        ],
      },
    };
    await runEffect(
      recordConversationTranscript(
        { ...record([]), uiTranscript: [receipt, answer, stats] },
        tmpDir,
      ),
    );
    expect(
      (await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir)))?.uiTranscript,
    ).toEqual([receipt, answer, stats]);
  });

  test("rejects duplicate identities before creating a log", async () => {
    await expect(
      runEffect(
        recordConversationTranscript({ ...record([]), uiTranscript: [receipt, receipt] }, tmpDir),
      ),
    ).rejects.toThrow("duplicate");
    expect(fs.existsSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir))).toBe(false);
  });

  test("names the entry and field a save rejects", async () => {
    const draft = { ...receipt, content: { kind: "user", text: "hi", secretDraft: "x" } };
    await expect(
      runEffect(
        recordConversationTranscript(
          { ...record([]), uiTranscript: [draft as unknown as typeof receipt] },
          tmpDir,
        ),
      ),
    ).rejects.toThrow(`Invalid user entry ${receipt.id} in conversation history: content`);
  });

  test("legacy migration preserves model and unreadable records, strips paint, and is idempotent", () => {
    const header = JSON.stringify({
      type: "conversation",
      version: 2,
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      startedAt: timestamp,
    });
    const message = JSON.stringify({
      type: "message",
      at: timestamp,
      message: userMessage("original"),
    });
    const ui = JSON.stringify({
      type: "ui-transcript",
      at: timestamp,
      entries: [{ type: "log", message: "\u001b[31mold receipt\u001b[0m" }],
    });
    const body = [header, message, "unreadable record", ui, ""].join("\n");
    const upgraded = migratePresentationLog(body);
    expect(upgraded).not.toBeNull();
    if (upgraded === null) throw new Error("Migration expected");
    expect(upgraded).toContain(message + "\nunreadable record\n");
    expect(migratePresentationLog(upgraded)).toBeNull();
    const uiEvent = parseConversationLog(upgraded).find((event) => event.type === "ui-transcript");
    expect(uiEvent?.type === "ui-transcript" ? uiEvent.entries : []).toEqual([
      {
        id: "legacy:3:0",
        timestamp,
        content: { kind: "notice", tone: "log", text: "old receipt" },
      },
    ]);
  });
});
