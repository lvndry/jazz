import { COMPANION_BRIEF_MARKER } from "@jazz/core/types/llm";
import { describe, expect, it } from "bun:test";
import {
  imagePromptFromMessages,
  isImageEndpointModel,
  selectImageModel,
} from "./image-generation";

describe("isImageEndpointModel", () => {
  it("recognizes each provider's image families", () => {
    expect(isImageEndpointModel("openai", "chatgpt-image-latest")).toBe(true);
    expect(isImageEndpointModel("openai", "gpt-image-1.5")).toBe(true);
    expect(isImageEndpointModel("gemini", "imagen-4.0-generate-001")).toBe(true);
    expect(isImageEndpointModel("xai", "grok-2-image")).toBe(true);
    expect(isImageEndpointModel("togetherai", "black-forest-labs/FLUX.1-schnell")).toBe(true);
  });

  it("leaves chat models that merely attach images on the chat path", () => {
    expect(isImageEndpointModel("openai", "gpt-5")).toBe(false);
    expect(isImageEndpointModel("gemini", "gemini-3-pro-image")).toBe(false);
    expect(isImageEndpointModel("anthropic", "gpt-image-1")).toBe(false);
  });
});

describe("selectImageModel", () => {
  it("builds an image model for providers with an image endpoint", () => {
    expect(selectImageModel("openai", "gpt-image-1.5", "key")).toMatchObject({
      modelId: "gpt-image-1.5",
    });
  });

  it("returns undefined for providers without one", () => {
    expect(selectImageModel("mistral", "any", "key")).toBeUndefined();
  });
});

describe("imagePromptFromMessages", () => {
  it("sends only the brief of a companion task", () => {
    const content = `[MODEL COMPANION TASK]\nRules\n${COMPANION_BRIEF_MARKER}a red fox`;
    expect(imagePromptFromMessages([{ role: "user", content }])).toBe("a red fox");
  });

  it("uses the latest user message as is otherwise", () => {
    expect(
      imagePromptFromMessages([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "a blue door" },
      ]),
    ).toBe("a blue door");
  });
});
