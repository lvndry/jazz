import { NodeFileSystem } from "@effect/platform-node";
import {
  EMPTY_CONVERSATION_REVISION,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";
import { silentLogger } from "@jazz/core/agent/test-logger";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { Agent } from "@jazz/core/types/agent";
import type { ChatCompletionOptions } from "@jazz/core/types/chat";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { partialFake } from "../test-support/partial-fake";
import { nameSavedConversation, shouldNameConversation } from "./name-conversation";

const firstAnswer = {
  ephemeral: false,
  turnErrored: false,
  conversationId: "conv-1",
  namerStartedFor: new Set<string>(),
};

describe("shouldNameConversation", () => {
  it("names a saved conversation after its first successful answer", () => {
    expect(shouldNameConversation(firstAnswer)).toBe(true);
  });

  it("leaves ephemeral sessions unnamed", () => {
    expect(shouldNameConversation({ ...firstAnswer, ephemeral: true })).toBe(false);
  });

  it("waits for a turn that succeeded", () => {
    expect(shouldNameConversation({ ...firstAnswer, turnErrored: true })).toBe(false);
  });

  it("starts the namer once per conversation, even after switching away and back", () => {
    const started = new Set(["conv-1", "conv-2"]);
    expect(shouldNameConversation({ ...firstAnswer, namerStartedFor: started })).toBe(false);
    expect(
      shouldNameConversation({
        ...firstAnswer,
        conversationId: "conv-3",
        namerStartedFor: started,
      }),
    ).toBe(true);
  });
});

describe("nameSavedConversation", () => {
  const agent = partialFake<Agent>({
    id: "naming-agent",
    name: "naming",
    config: { persona: "default", llm: { provider: "openai", model: "gpt-4o-mini" } },
  });
  const exchange = [
    { role: "user", content: "how do I repot a monstera?" },
    { role: "assistant", content: "Spring, a pot one size up, and a chunky mix." },
  ] as ChatMessage[];

  async function nameWith(conversationId: string) {
    let modelCalls = 0;
    const llm = partialFake<LLMService>({
      createChatCompletion: (_provider: string, options: ChatCompletionOptions) => {
        modelCalls += 1;
        return Effect.succeed({ id: "1", model: options.model, content: "Repotting a monstera" });
      },
    });
    const naming = await Effect.runPromise(
      nameSavedConversation(agent, conversationId).pipe(
        Effect.provideService(LLMServiceTag, llm),
        Effect.provideService(LoggerServiceTag, silentLogger),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
    return { naming, modelCalls };
  }

  function save(
    conversationId: string,
    overrides: { title?: string; titleSource?: "user"; messages?: ChatMessage[] } = {},
  ) {
    return Effect.runPromise(
      saveConversation({
        conversationId,
        agentId: agent.id,
        title: overrides.title ?? "",
        ...(overrides.titleSource === undefined ? {} : { titleSource: overrides.titleSource }),
        startedAt: new Date().toISOString(),
        messages: overrides.messages ?? [...exchange],
        basedOn: EMPTY_CONVERSATION_REVISION,
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  }

  it("names a saved conversation once, then skips without calling the model", async () => {
    await save("naming-once");
    const first = await nameWith("naming-once");
    const second = await nameWith("naming-once");

    expect(first.naming).toMatchObject({ kind: "asked", title: "Repotting a monstera" });
    expect(second).toEqual({
      naming: { kind: "skipped", reason: "already-named" },
      modelCalls: 0,
    });
  });

  it("reports a conversation that is not saved yet, so the chat can try again", async () => {
    expect(await nameWith("naming-unsaved")).toEqual({
      naming: { kind: "skipped", reason: "not-saved" },
      modelCalls: 0,
    });
  });

  it("leaves a conversation a person named, or one a checkpoint names, alone", async () => {
    await save("naming-person", { title: "Plants", titleSource: "user" });
    await save("naming-checkpoint", {
      messages: [
        { role: "user", content: "## Title\nHouseplant care\n\n## Goal\n...", kind: "summary" },
        ...exchange,
      ],
    });

    for (const conversationId of ["naming-person", "naming-checkpoint"]) {
      expect(await nameWith(conversationId)).toEqual({
        naming: { kind: "skipped", reason: "already-named" },
        modelCalls: 0,
      });
    }
  });
});
