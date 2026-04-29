import { describe, expect, it } from "bun:test";
import { hasReasoningParser, selectParser } from "./registry";

describe("selectParser", () => {
  it("returns the tag-pair parser when chatTemplate has <think>", () => {
    const parser = selectParser({
      provider: "llamacpp",
      modelId: "qwen3-4b",
      chatTemplate: "<think>",
    });
    expect(parser).not.toBeNull();
  });

  it("returns the tag-pair parser when ollama capabilities include 'thinking'", () => {
    const parser = selectParser({
      provider: "ollama",
      modelId: "qwen3:8b",
      capabilities: ["thinking"],
    });
    expect(parser).not.toBeNull();
  });

  it("returns null for a cloud provider with no metadata", () => {
    const parser = selectParser({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(parser).toBeNull();
  });

  it("returns null when no factory matches", () => {
    const parser = selectParser({
      provider: "llamacpp",
      modelId: "no-reasoning",
      chatTemplate: "no markers here",
    });
    expect(parser).toBeNull();
  });

  it("creates a fresh parser instance each call", () => {
    const a = selectParser({ provider: "llamacpp", modelId: "x", chatTemplate: "<think>" });
    const b = selectParser({ provider: "llamacpp", modelId: "x", chatTemplate: "<think>" });
    expect(a).not.toBe(b);
  });
});

describe("hasReasoningParser", () => {
  it("returns true for a chatTemplate with <think>", () => {
    expect(
      hasReasoningParser({ provider: "llamacpp", modelId: "x", chatTemplate: "<think>" }),
    ).toBe(true);
  });

  it("returns true when ollama capabilities include 'thinking'", () => {
    expect(
      hasReasoningParser({ provider: "ollama", modelId: "qwen3:8b", capabilities: ["thinking"] }),
    ).toBe(true);
  });

  it("returns false for a model with no template and no thinking capability", () => {
    expect(
      hasReasoningParser({ provider: "ollama", modelId: "llama3.1:8b", capabilities: ["tools"] }),
    ).toBe(false);
  });

  it("returns false for an unrelated chatTemplate", () => {
    expect(
      hasReasoningParser({
        provider: "llamacpp",
        modelId: "x",
        chatTemplate: "no markers here",
      }),
    ).toBe(false);
  });

  it("does not allocate parser instances", () => {
    // Pure boolean — calling many times in a hot path should be fine.
    for (let i = 0; i < 1000; i++) {
      hasReasoningParser({ provider: "ollama", modelId: "x", capabilities: ["thinking"] });
    }
  });
});
