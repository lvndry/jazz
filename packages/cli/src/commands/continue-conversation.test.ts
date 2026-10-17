import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import {
  EMPTY_CONVERSATION_REVISION,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";
import type { Agent } from "@jazz/core/types";
import { afterAll, describe, expect, it } from "bun:test";
import { Effect, Result } from "effect";
import { continuedSessionOptions } from "./continue-conversation";

const historyDirectory = mkdtempSync(path.join(tmpdir(), "jazz-continue-"));
afterAll(() => {
  rmSync(historyDirectory, { recursive: true, force: true });
});

const agent = {
  id: "continue-agent",
  name: "Continuer",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-5" }, tools: [] },
  createdAt: new Date(),
  updatedAt: new Date(),
} as Agent;

function resolve(options: Parameters<typeof continuedSessionOptions>[1]) {
  return Effect.runPromise(
    Effect.result(continuedSessionOptions(agent, options, historyDirectory)).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

describe("continuedSessionOptions", () => {
  it("starts fresh without --continue", async () => {
    expect(await resolve(undefined)).toEqual(Result.succeed({}));
  });

  it("refuses --conversation without --continue, and --continue with nothing saved", async () => {
    expect(Result.isFailure(await resolve({ conversation: "c1" }))).toBe(true);
    expect(Result.isFailure(await resolve({ continue: true }))).toBe(true);
  });

  it("continues the saved conversation", async () => {
    await Effect.runPromise(
      saveConversation(
        {
          conversationId: "c1",
          title: "Groceries",
          agentId: agent.id,
          startedAt: new Date().toISOString(),
          messages: [
            { role: "user", content: "add milk" },
            { role: "assistant", content: "Added." },
          ],
          basedOn: EMPTY_CONVERSATION_REVISION,
        },
        historyDirectory,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    const latest = await resolve({ continue: true });
    const named = await resolve({ continue: true, conversation: "c1" });
    for (const result of [latest, named]) {
      expect(Result.isSuccess(result) && result.success.initialHistory?.length).toBe(2);
    }
  });
});
