import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  deleteSession,
  deriveSessionTitle,
  getSessionLogPath,
  listSessions,
  makeSessionId,
  parseSessionEventLine,
  readSession,
  recordSessionTranscript,
  resetSessionAppendCache,
  sessionIdBelongsToAgent,
} from "./session-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-store-test-"));
  resetSessionAppendCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetSessionAppendCache();
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

function logLines(sessionId: string): string[] {
  const content = fs.readFileSync(getSessionLogPath(sessionId, tmpDir), "utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

function messageLineCount(sessionId: string): number {
  return logLines(sessionId).filter((line) => line.includes('"type":"message"')).length;
}

describe("makeSessionId", () => {
  test("combines agent and conversation ids", () => {
    expect(makeSessionId("agent-1", "conv-1")).toBe("agent-1~conv-1");
  });

  test("keeps unsafe conversation ids in one file each", () => {
    const first = makeSessionId("agent-1", "chat/../etc/passwd");
    const second = makeSessionId("agent-1", "chat/../etc/shadow");
    expect(first).not.toBe(second);
    expect(first).not.toContain("/");
    expect(path.basename(`${first}.jsonl`)).toBe(`${first}.jsonl`);
  });

  test("recognizes the owning agent", () => {
    const sessionId = makeSessionId("agent-1", "conv-1");
    expect(sessionIdBelongsToAgent(sessionId, "agent-1")).toBe(true);
    expect(sessionIdBelongsToAgent(sessionId, "agent-2")).toBe(false);
  });
});

describe("recordSessionTranscript", () => {
  test("writes a header and one line per message", async () => {
    const sessionId = await runEffect(
      recordSessionTranscript(record([userMessage("hi"), assistantMessage("hello")]), tmpDir),
    );
    expect(sessionId).toBe("agent-1~conv-1");
    const lines = logLines(sessionId);
    expect(lines[0]).toContain('"type":"session"');
    expect(messageLineCount(sessionId)).toBe(2);
  });

  test("appends only the new messages instead of rewriting the log", async () => {
    const first = [userMessage("hi"), assistantMessage("hello")];
    const sessionId = await runEffect(recordSessionTranscript(record(first), tmpDir));
    const bytesAfterFirst = fs.statSync(getSessionLogPath(sessionId, tmpDir)).size;

    const second = [...first, userMessage("and again"), assistantMessage("sure")];
    await runEffect(recordSessionTranscript(record(second), tmpDir));

    const content = fs.readFileSync(getSessionLogPath(sessionId, tmpDir), "utf-8");
    expect(messageLineCount(sessionId)).toBe(4);
    // The original bytes are still the prefix of the file: nothing was rewritten.
    expect(content.length).toBeGreaterThan(bytesAfterFirst);
    expect(content.indexOf('"hello"')).toBeLessThan(content.indexOf('"and again"'));
  });

  test("counts existing messages from disk when the process has no cache", async () => {
    const first = [userMessage("hi"), assistantMessage("hello")];
    const sessionId = await runEffect(recordSessionTranscript(record(first), tmpDir));

    resetSessionAppendCache();
    await runEffect(recordSessionTranscript(record([...first, userMessage("resumed")]), tmpDir));

    expect(messageLineCount(sessionId)).toBe(3);
    const session = await runEffect(readSession(sessionId, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual(["hi", "hello", "resumed"]);
  });

  test("a replaced transcript supersedes the old one instead of concatenating", async () => {
    const original = [userMessage("hi"), assistantMessage("hello"), userMessage("more")];
    const sessionId = await runEffect(recordSessionTranscript(record(original), tmpDir));

    const compacted: ChatMessage[] = [
      { role: "assistant", content: "summary of earlier turns", kind: "summary" },
      userMessage("carry on"),
    ];
    await runEffect(recordSessionTranscript(record(compacted), tmpDir));

    const session = await runEffect(readSession(sessionId, tmpDir));
    expect(session?.messages.map((message) => message.content)).toEqual([
      "summary of earlier turns",
      "carry on",
    ]);
    // The superseded lines are still on disk — search can still reach them.
    expect(messageLineCount(sessionId)).toBe(5);
  });

  test("tolerates a truncated final line and keeps appending cleanly", async () => {
    const sessionId = await runEffect(
      recordSessionTranscript(record([userMessage("hi"), assistantMessage("hello")]), tmpDir),
    );

    const logPath = getSessionLogPath(sessionId, tmpDir);
    fs.appendFileSync(logPath, '{"type":"message","at":"2026-08-01T10:0');

    const afterCrash = await runEffect(readSession(sessionId, tmpDir));
    expect(afterCrash?.messages.map((message) => message.content)).toEqual(["hi", "hello"]);

    resetSessionAppendCache();
    await runEffect(
      recordSessionTranscript(
        record([userMessage("hi"), assistantMessage("hello"), userMessage("after the crash")]),
        tmpDir,
      ),
    );

    const recovered = await runEffect(readSession(sessionId, tmpDir));
    expect(recovered?.messages.map((message) => message.content)).toEqual([
      "hi",
      "hello",
      "after the crash",
    ]);
  });

  test("records a title change and an end time as metadata", async () => {
    const sessionId = await runEffect(
      recordSessionTranscript(record([userMessage("hi")], "First title"), tmpDir),
    );
    await runEffect(
      recordSessionTranscript(
        { ...record([userMessage("hi")], "Second title"), endedAt: "2026-08-01T11:00:00.000Z" },
        tmpDir,
      ),
    );

    const session = await runEffect(readSession(sessionId, tmpDir));
    expect(session?.title).toBe("Second title");
    expect(session?.endedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  test("preserves the started-at instant across appends", async () => {
    const sessionId = await runEffect(recordSessionTranscript(record([userMessage("hi")]), tmpDir));
    await runEffect(
      recordSessionTranscript(
        {
          ...record([userMessage("hi"), userMessage("two")]),
          startedAt: "2027-01-01T00:00:00.000Z",
        },
        tmpDir,
      ),
    );
    const session = await runEffect(readSession(sessionId, tmpDir));
    expect(session?.startedAt).toBe("2026-08-01T10:00:00.000Z");
  });
});

describe("readSession", () => {
  test("returns null for a session that was never written", async () => {
    expect(await runEffect(readSession("agent-1~nope", tmpDir))).toBeNull();
  });

  test("returns null when the log has no readable header", async () => {
    const logPath = getSessionLogPath("agent-1~broken", tmpDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "not json at all\n");
    expect(await runEffect(readSession("agent-1~broken", tmpDir))).toBeNull();
  });
});

describe("listSessions", () => {
  test("lists newest first and filters by agent", async () => {
    await runEffect(
      recordSessionTranscript(
        { ...record([userMessage("one")]), conversationId: "conv-1" },
        tmpDir,
      ),
    );
    await runEffect(
      recordSessionTranscript(
        { ...record([userMessage("two")]), conversationId: "conv-2" },
        tmpDir,
      ),
    );
    await runEffect(
      recordSessionTranscript(
        { ...record([userMessage("other")]), agentId: "agent-2", conversationId: "conv-3" },
        tmpDir,
      ),
    );

    const forAgentOne = await runEffect(listSessions(tmpDir, "agent-1"));
    expect(forAgentOne.map((session) => session.sessionId).sort()).toEqual([
      "agent-1~conv-1",
      "agent-1~conv-2",
    ]);
    expect(await runEffect(listSessions(tmpDir))).toHaveLength(3);
  });

  test("returns nothing when no session has been written", async () => {
    expect(await runEffect(listSessions(tmpDir, "agent-1"))).toEqual([]);
  });
});

describe("deleteSession", () => {
  test("removes the log and is safe to repeat", async () => {
    const sessionId = await runEffect(recordSessionTranscript(record([userMessage("hi")]), tmpDir));
    await runEffect(deleteSession(sessionId, tmpDir));
    expect(fs.existsSync(getSessionLogPath(sessionId, tmpDir))).toBe(false);
    await runEffect(deleteSession(sessionId, tmpDir));
  });

  // Eviction deletes a log the process may still hold append state for. If the
  // cache survived the delete, the next append would skip the header and the
  // messages it thinks are already there, leaving a log that reads back as
  // nothing at all.
  test("a session written again after deletion is readable", async () => {
    const messages = [userMessage("hi"), assistantMessage("hello")];
    const sessionId = await runEffect(recordSessionTranscript(record(messages), tmpDir));
    await runEffect(deleteSession(sessionId, tmpDir));

    await runEffect(recordSessionTranscript(record(messages), tmpDir));

    const reread = await runEffect(readSession(sessionId, tmpDir));
    expect(reread).not.toBeNull();
    expect(reread?.messages).toHaveLength(2);
    expect(reread?.title).toBe("Trip planning");
    expect(messageLineCount(sessionId)).toBe(2);
  });
});

describe("parseSessionEventLine", () => {
  test("rejects blank, non-JSON, and unknown lines", () => {
    expect(parseSessionEventLine("")).toBeNull();
    expect(parseSessionEventLine("{oops")).toBeNull();
    expect(parseSessionEventLine('{"type":"nonsense"}')).toBeNull();
    expect(
      parseSessionEventLine('{"type":"message","message":{"role":"ghost","content":"x"}}'),
    ).toBeNull();
  });

  test("reads a message event", () => {
    const event = parseSessionEventLine(
      '{"type":"message","at":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
    );
    expect(event).toEqual({
      type: "message",
      at: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "hi" },
    });
  });
});

describe("deriveSessionTitle", () => {
  test("prefers an explicit title", () => {
    expect(deriveSessionTitle("Trip planning", [userMessage("hello")])).toBe("Trip planning");
  });

  test("falls back to the first user message on one line", () => {
    expect(
      deriveSessionTitle("  ", [assistantMessage("hi"), userMessage("book\n the flights")]),
    ).toBe("book the flights");
  });

  test("names an empty session rather than returning nothing", () => {
    expect(deriveSessionTitle(undefined, [])).toBe("untitled session");
  });
});
