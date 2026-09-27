import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  collapseSupersededUiEvents,
  deleteConversationLog,
  deriveConversationTitle,
  conversationLogPath,
  listConversationLogs,
  parseConversationLogLine,
  readConversationLog,
  recordConversationTranscript,
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

function record(messages: readonly ChatMessage[], title = "Trip planning") {
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    title,
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: null,
    messages,
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
    await runEffect(recordConversationTranscript(record(first), tmpDir));
    const bytesAfterFirst = fs.statSync(
      conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir),
    ).size;

    const second = [...first, userMessage("and again"), assistantMessage("sure")];
    await runEffect(recordConversationTranscript(record(second), tmpDir));

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
      recordConversationTranscript(record([...first, userMessage("resumed")]), tmpDir),
    );

    expect(messageLineCount()).toBe(3);
    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual(["hi", "hello", "resumed"]);
  });

  test("a replaced transcript supersedes the old one instead of concatenating", async () => {
    const original = [userMessage("hi"), assistantMessage("hello"), userMessage("more")];
    await runEffect(recordConversationTranscript(record(original), tmpDir));

    const compacted: ChatMessage[] = [
      { role: "assistant", content: "summary of earlier turns", kind: "summary" },
      userMessage("carry on"),
    ];
    await runEffect(recordConversationTranscript(record(compacted), tmpDir));

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual([
      "summary of earlier turns",
      "carry on",
    ]);
    // The superseded lines are still on disk — search can still reach them.
    expect(messageLineCount()).toBe(5);
  });

  test("tolerates a truncated final line and keeps appending cleanly", async () => {
    await runEffect(
      recordConversationTranscript(record([userMessage("hi"), assistantMessage("hello")]), tmpDir),
    );

    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    fs.appendFileSync(logPath, '{"type":"message","at":"2026-08-01T10:0');

    const afterCrash = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(afterCrash?.messages.map((message) => message.content)).toEqual(["hi", "hello"]);

    await runEffect(
      recordConversationTranscript(
        record([userMessage("hi"), assistantMessage("hello"), userMessage("after the crash")]),
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

  test("records a title change and an end time as metadata", async () => {
    await runEffect(
      recordConversationTranscript(record([userMessage("hi")], "First title"), tmpDir),
    );
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("hi")], "Second title"), endedAt: "2026-08-01T11:00:00.000Z" },
        tmpDir,
      ),
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.title).toBe("Second title");
    expect(session?.endedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  test("preserves the started-at instant across appends", async () => {
    await runEffect(recordConversationTranscript(record([userMessage("hi")]), tmpDir));
    await runEffect(
      recordConversationTranscript(
        {
          ...record([userMessage("hi"), userMessage("two")]),
          startedAt: "2027-01-01T00:00:00.000Z",
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
            { type: "user", message: "/info" },
            { type: "log", message: "Conversation info" },
          ],
        },
        tmpDir,
      ),
    );

    const session = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(session?.messages).toEqual([userMessage("hi")]);
    expect(session?.uiTranscript).toEqual([
      { type: "user", message: "/info" },
      { type: "log", message: "Conversation info" },
    ]);
  });
});

describe("UI scrollback growth", () => {
  const TURN_PADDING = " ".repeat(200);
  const ANSWER_PADDING = "x".repeat(800);

  /** One chat turn: about a kilobyte of messages and the same again of scrollback. */
  function turnsOfChat(turns: number) {
    const messages: ChatMessage[] = [];
    const uiTranscript: { type: "user" | "info"; message: string }[] = [];
    for (let turn = 0; turn < turns; turn++) {
      messages.push(userMessage(`question ${turn}${TURN_PADDING}`));
      messages.push(assistantMessage(`answer ${turn}${ANSWER_PADDING}`));
      uiTranscript.push({ type: "user", message: `question ${turn}${TURN_PADDING}` });
      uiTranscript.push({ type: "info", message: `answer ${turn}${ANSWER_PADDING}` });
    }
    return { messages, uiTranscript };
  }

  test("a log grows linearly with the turns of a chat that saves every turn", async () => {
    const logPath = conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir);
    const sizes = new Map<number, number>();
    const { messages, uiTranscript } = turnsOfChat(200);
    for (let turn = 1; turn <= 200; turn++) {
      await runEffect(
        recordConversationTranscript(
          {
            ...record(messages.slice(0, turn * 2)),
            uiTranscript: uiTranscript.slice(0, turn * 2),
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
    const first = [{ type: "user" as const, message: "hi" }];
    const second = [...first, { type: "info" as const, message: "hello" }];
    const cleared = [{ type: "info" as const, message: "fresh start" }];
    for (const uiTranscript of [first, second, cleared]) {
      await runEffect(
        recordConversationTranscript({ ...record([userMessage("hi")]), uiTranscript }, tmpDir),
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
    const uiTranscript = [{ type: "user" as const, message: "hi" }];
    await runEffect(
      recordConversationTranscript({ ...record([userMessage("hi")]), uiTranscript }, tmpDir),
    );
    const before = logLines().length;
    await runEffect(
      recordConversationTranscript({ ...record([userMessage("hi")]), uiTranscript }, tmpDir),
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
      { type: "info" as const, message: "more" },
    ];
    await runEffect(
      recordConversationTranscript(
        { ...record([userMessage("hi")]), uiTranscript: nextScrollback },
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
    const content = [
      '{"type":"ui-transcript","at":"t","entries":[]}',
      "not json",
      '{"type":"ui-append","at":"t","entries":[]}',
      '{"type":"ui-transcript","at":"t","entries":[{"type":"user","message":"x"}]}',
      "",
    ].join("\n");
    expect(collapseSupersededUiEvents(content)).toBe(
      [
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

    await runEffect(
      recordConversationTranscript(
        record([userMessage("hi"), assistantMessage("from elsewhere"), userMessage("next")]),
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

  test("names an empty conversation rather than returning nothing", () => {
    expect(deriveConversationTitle(undefined, [])).toBe("untitled conversation");
  });
});
