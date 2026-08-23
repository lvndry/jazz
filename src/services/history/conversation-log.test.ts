import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  deleteConversationLog,
  deriveConversationTitle,
  conversationLogPath,
  listConversationLogs,
  parseConversationLogLine,
  readConversationLog,
  recordConversationTranscript,
  resetConversationLogAppendCache,
} from "./conversation-log";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-store-test-"));
  resetConversationLogAppendCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetConversationLogAppendCache();
});

function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
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

  test("counts existing messages from disk when the process has no cache", async () => {
    const first = [userMessage("hi"), assistantMessage("hello")];
    await runEffect(recordConversationTranscript(record(first), tmpDir));

    resetConversationLogAppendCache();
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

    resetConversationLogAppendCache();
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

  // Eviction deletes a log the process may still hold append state for. If the
  // cache survived the delete, the next append would skip the header and the
  // messages it thinks are already there, leaving a log that reads back as
  // nothing at all.
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
