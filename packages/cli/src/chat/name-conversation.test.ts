import { describe, expect, it } from "bun:test";
import { shouldNameConversation } from "./name-conversation";

const firstAnswer = {
  ephemeral: false,
  turnErrored: false,
  conversationTitle: undefined,
  conversationId: "conv-1",
  namerStartedFor: undefined,
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

  it("starts the namer once per conversation", () => {
    expect(shouldNameConversation({ ...firstAnswer, namerStartedFor: "conv-1" })).toBe(false);
    expect(shouldNameConversation({ ...firstAnswer, namerStartedFor: "conv-0" })).toBe(true);
  });
});
