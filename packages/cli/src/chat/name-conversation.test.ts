import { describe, expect, it } from "bun:test";
import { shouldNameConversation } from "./name-conversation";

const firstAnswer = {
  ephemeral: false,
  turnErrored: false,
  conversationTitle: undefined,
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

  it("keeps a conversation that already has a title", () => {
    expect(shouldNameConversation({ ...firstAnswer, conversationTitle: "Summer trip" })).toBe(
      false,
    );
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
