import type { ModelMessage } from "ai";
import { describe, expect, it } from "bun:test";
import { extractReasoningParts } from "./reasoning-parts";

describe("extractReasoningParts", () => {
  it("extracts reasoning parts from assistant messages with provider tag and verbatim payload", () => {
    const responseMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking about the weather",
            providerOptions: { anthropic: { signature: "sig-abc123" } },
          },
          { type: "text", text: "It is sunny." },
        ],
      },
    ];

    const parts = extractReasoningParts(responseMessages, "anthropic");

    expect(parts).toEqual([
      {
        text: "thinking about the weather",
        provider: "anthropic",
        providerOptions: { anthropic: { signature: "sig-abc123" } },
      },
    ]);
  });

  it("preserves multiple reasoning blocks in order across assistant messages", () => {
    const responseMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "block one" },
          { type: "reasoning", text: "block two", providerOptions: { openai: { itemId: "rs_1" } } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "block three" }],
      },
    ];

    const parts = extractReasoningParts(responseMessages, "openai");

    expect(parts?.map((part) => part.text)).toEqual(["block one", "block two", "block three"]);
  });

  it("keeps redacted blocks that have empty text but a provider payload", () => {
    const responseMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { anthropic: { redactedData: "opaque-blob" } },
          },
        ],
      },
    ];

    const parts = extractReasoningParts(responseMessages, "anthropic");

    expect(parts).toHaveLength(1);
    expect(parts?.[0]?.providerOptions).toEqual({ anthropic: { redactedData: "opaque-blob" } });
  });

  it("returns undefined when there is no reasoning", () => {
    const responseMessages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "plain answer" }] },
      { role: "assistant", content: "string content" },
    ];

    expect(extractReasoningParts(responseMessages, "anthropic")).toBeUndefined();
  });

  it("ignores non-assistant messages and empty parts", () => {
    const responseMessages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "reasoning", text: "real" },
        ],
      },
    ];

    const parts = extractReasoningParts(responseMessages, "openrouter");

    expect(parts).toEqual([{ text: "real", provider: "openrouter" }]);
  });
});
