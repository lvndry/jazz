import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  claimUnreflectedMessages,
  releaseReflectionClaim,
  type ReflectionClaim,
} from "./reflection-watermark";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-reflection-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function claimWithRelease(messages: readonly ChatMessage[], conversationId = "conversation-1") {
  return Effect.runPromise(
    claimUnreflectedMessages(tmpDir, "agent-1", conversationId, messages).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

async function claim(messages: readonly ChatMessage[], conversationId = "conversation-1") {
  return (await claimWithRelease(messages, conversationId)).messages;
}

function release(reflectionClaim: ReflectionClaim, conversationId = "conversation-1") {
  return Effect.runPromise(
    releaseReflectionClaim(tmpDir, "agent-1", conversationId, reflectionClaim).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

const firstSession: ChatMessage[] = [
  { role: "system", content: "system prompt", entryId: "system" },
  { role: "user", content: "plan a reader", entryId: "entry-1" },
  { role: "assistant", content: "here is a plan", entryId: "entry-2" },
];

describe("claimUnreflectedMessages", () => {
  test("hands out each message once, leaving out the system prompt", async () => {
    expect((await claim(firstSession)).map((message) => message.entryId)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    expect(await claim(firstSession)).toEqual([]);

    const reopened: ChatMessage[] = [
      ...firstSession,
      { role: "user", content: "does this exist already?", entryId: "entry-3" },
      { role: "assistant", content: "yes, Readest", entryId: "entry-4" },
    ];
    expect((await claim(reopened)).map((message) => message.entryId)).toEqual([
      "entry-3",
      "entry-4",
    ]);
  });

  test("reflects on the whole history once compaction folded the watermark away", async () => {
    await claim(firstSession);
    const compacted: ChatMessage[] = [
      { role: "assistant", content: "summary", kind: "summary", entryId: "summary-1" },
      { role: "user", content: "next", entryId: "entry-5" },
    ];

    expect((await claim(compacted)).map((message) => message.entryId)).toEqual([
      "summary-1",
      "entry-5",
    ]);
  });

  test("tracks conversations separately", async () => {
    await claim(firstSession, "conversation-1");
    expect(await claim(firstSession, "conversation-2")).toHaveLength(2);
  });

  test("a released claim hands the same messages out again", async () => {
    await claim(firstSession);
    const reopened: ChatMessage[] = [
      ...firstSession,
      { role: "user", content: "does this exist already?", entryId: "entry-3" },
    ];
    const failedPass = await claimWithRelease(reopened);
    await release(failedPass);

    expect((await claim(reopened)).map((message) => message.entryId)).toEqual(["entry-3"]);
  });

  test("releasing a first claim forgets the conversation entirely", async () => {
    await release(await claimWithRelease(firstSession));

    expect(await claim(firstSession)).toHaveLength(2);
  });

  test("a release does not undo a later pass that claimed further", async () => {
    const failedPass = await claimWithRelease(firstSession);
    const later: ChatMessage[] = [
      ...firstSession,
      { role: "user", content: "next", entryId: "entry-3" },
    ];
    await claim(later);
    await release(failedPass);

    expect(await claim(later)).toEqual([]);
  });
});
