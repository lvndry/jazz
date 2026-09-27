import { describe, expect, it } from "bun:test";
import { isRunCostKnown } from "./run-spend";

describe("isRunCostKnown", () => {
  it("accepts provider pricing, including a real zero", () => {
    expect(isRunCostKnown(0, "openai", "free-model")).toBe(true);
    expect(isRunCostKnown(0.01, "openai", "priced-model")).toBe(true);
  });

  it("recognizes local servers as zero-cost without misclassifying Ollama Cloud", () => {
    expect(isRunCostKnown(undefined, "llamacpp", "local.gguf")).toBe(true);
    expect(isRunCostKnown(undefined, "ollama", "qwen3:8b")).toBe(true);
    expect(isRunCostKnown(undefined, "ollama", "kimi-k3:cloud")).toBe(false);
  });

  it("marks missing remote pricing as unknown", () => {
    expect(isRunCostKnown(undefined, "openai", "unlisted-model")).toBe(false);
  });

  it("treats an incomplete total as unknown even when costUSD is defined", () => {
    expect(isRunCostKnown(0.02, "openai", "priced-model", true)).toBe(false);
    expect(isRunCostKnown(undefined, "llamacpp", "local.gguf", true)).toBe(false);
    expect(isRunCostKnown(0.02, "openai", "priced-model", false)).toBe(true);
  });
});
