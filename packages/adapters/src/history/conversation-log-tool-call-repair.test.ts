/** Loading a log written by a version that persisted tool calls with an empty id or name. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, type FileSystem } from "effect";
import {
  conversationLogPath,
  conversationRevision,
  EMPTY_CONVERSATION_REVISION,
  readConversationLog,
  recordConversationTranscript,
} from "./conversation-log";

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conv-1";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-tool-call-repair-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

function logLines(): string[] {
  return fs
    .readFileSync(conversationLogPath(AGENT_ID, CONVERSATION_ID, tmpDir), "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

const blankCall = {
  id: "",
  type: "function" as const,
  function: { name: "", arguments: "{}" },
};

const stored: ChatMessage[] = [
  { role: "user", content: "look" },
  { role: "assistant", content: "", tool_calls: [blankCall] },
  { role: "tool", content: "found it", tool_call_id: "", name: "" },
  { role: "assistant", content: "done" },
];

describe("loading a conversation with an empty-identity tool call", () => {
  test("repairs the call on read, continues, and saves without rewriting the stored lines", async () => {
    await runEffect(
      recordConversationTranscript(
        {
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          title: "Search",
          startedAt: "2026-08-01T10:00:00.000Z",
          messages: stored,
          basedOn: EMPTY_CONVERSATION_REVISION,
        },
        tmpDir,
      ),
    );
    const before = logLines();

    const loaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    const callId = loaded?.messages[1]?.tool_calls?.[0]?.id ?? "";
    expect(callId.length).toBeGreaterThan(0);
    expect(loaded?.messages[1]?.tool_calls?.[0]?.function.name).toBe("unknown_tool");
    expect(loaded?.messages[2]?.tool_call_id).toBe(callId);
    expect(logLines()).toEqual(before);

    const reloaded = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(reloaded?.messages[1]?.tool_calls?.[0]?.id).toBe(callId);

    const loadedMessages = loaded?.messages ?? [];
    await runEffect(
      recordConversationTranscript(
        {
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          title: "Search",
          startedAt: "2026-08-01T10:00:00.000Z",
          messages: [...loadedMessages, { role: "user", content: "again" }],
          basedOn: conversationRevision(loadedMessages),
        },
        tmpDir,
      ),
    );
    expect(logLines().slice(0, before.length)).toEqual(before);

    const continued = await runEffect(readConversationLog(AGENT_ID, CONVERSATION_ID, tmpDir));
    expect(continued?.messages.map((message) => message.content)).toEqual([
      "look",
      "",
      "found it",
      "done",
      "again",
    ]);
    expect(continued?.messages[1]?.tool_calls?.[0]?.id).toBe(callId);
  });
});
