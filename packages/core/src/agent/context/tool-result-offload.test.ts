import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import {
  isSafeToolCallId,
  persistLargeToolResults,
  persistToolResult,
  readOffloadedToolResult,
  readOffloadedToolResultProvenance,
  toolResultOffloadPath,
  writeToolResult,
} from "./tool-result-offload";

const runEffect = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect);

const modelHint = { provider: "openai", modelId: "gpt-4o" };

const fixedCounter = {
  countMessage: (message: ChatMessage) => Math.ceil((message.content?.length ?? 0) / 4),
  countMessages: (messages: readonly ChatMessage[]) =>
    messages.reduce((total, message) => total + Math.ceil((message.content?.length ?? 0) / 4), 0),
} as any;

describe("tool result offload", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-offload-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("rejects path-traversal ids", () => {
    expect(isSafeToolCallId("../etc/passwd")).toBe(false);
    expect(isSafeToolCallId("call_abc-1.2")).toBe(true);
  });

  it("writes a body and reads it back", async () => {
    expect(await runEffect(persistToolResult("agent-1", "conv-1", "call_1", "hello body"))).toBe(
      true,
    );
    expect(await runEffect(readOffloadedToolResult("agent-1", "conv-1", "call_1"))).toBe(
      "hello body",
    );
    const stored = await nodeFs.readFile(
      toolResultOffloadPath("agent-1", "conv-1", "call_1"),
      "utf-8",
    );
    expect(stored).toBe("hello body");
  });

  it("is a no-op write when the file already exists", async () => {
    await runEffect(persistToolResult("agent-1", "conv-1", "call_1", "first"));
    await runEffect(persistToolResult("agent-1", "conv-1", "call_1", "second"));
    expect(await runEffect(readOffloadedToolResult("agent-1", "conv-1", "call_1"))).toBe("first");
  });

  it("reads back the provenance kept beside a body", async () => {
    const provenance = { kind: "external", source: "web_fetch https://example.com" } as const;
    expect(writeToolResult("agent-1", "conv-1", "call_1", "page text", provenance)).toBe(true);
    expect(
      await runEffect(
        readOffloadedToolResultProvenance("agent-1", "conv-1", "call_1", "page text"),
      ),
    ).toEqual(provenance);
  });

  it("reads the envelope's kind from a body stored already framed", async () => {
    const framed =
      '<untrusted-content source="web_fetch x" kind="external">\nhi\n</untrusted-content>';
    await runEffect(persistToolResult("agent-1", "conv-1", "call_1", framed));
    expect(
      await runEffect(readOffloadedToolResultProvenance("agent-1", "conv-1", "call_1", framed)),
    ).toEqual({ kind: "external", source: "retrieve_tool_result call_1" });
    expect(
      await runEffect(readOffloadedToolResultProvenance("agent-1", "conv-1", "call_1", "plain")),
    ).toBeUndefined();
  });

  it("returns undefined rather than throwing when nothing was stored", async () => {
    expect(
      await runEffect(readOffloadedToolResult("agent-1", "conv-1", "missing")),
    ).toBeUndefined();
  });

  it("reports failure instead of throwing when the path cannot be written", async () => {
    process.env["JAZZ_HOME"] = "/proc/nonexistent-jazz-home";
    expect(await runEffect(persistToolResult("agent-1", "conv-1", "call_1", "nope"))).toBe(false);
    expect(await runEffect(readOffloadedToolResult("agent-1", "conv-1", "call_1"))).toBeUndefined();
  });

  it("persists only large uncleared results and skips unsafe ids", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      {
        role: "tool",
        tool_call_id: "call_big",
        content: "x".repeat(20_000),
      } as ChatMessage,
      { role: "tool", tool_call_id: "tiny", content: "ok" } as ChatMessage,
      {
        role: "tool",
        tool_call_id: "../escape",
        content: "x".repeat(20_000),
      } as ChatMessage,
      {
        role: "tool",
        tool_call_id: "already",
        content: "x".repeat(20_000),
        cleared: true,
      } as ChatMessage,
    ];

    const retrievable = await runEffect(
      persistLargeToolResults(messages, {
        agentId: "agent-1",
        conversationId: "conv-1",
        modelHint,
        tokenCounter: fixedCounter,
      }),
    );

    expect([...retrievable]).toEqual(["call_big"]);
  });

  it("skips persist entirely when there is no conversation id", async () => {
    const retrievable = await runEffect(
      persistLargeToolResults(
        [{ role: "tool", tool_call_id: "call_1", content: "x".repeat(20_000) } as ChatMessage],
        {
          agentId: "agent-1",
          conversationId: "",
          modelHint,
          tokenCounter: fixedCounter,
        },
      ),
    );
    expect(retrievable.size).toBe(0);
  });
});
