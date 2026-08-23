import { describe, expect, it } from "bun:test";
import { isZeroCostLocalModel } from "./local-providers";

describe("isZeroCostLocalModel", () => {
  it("treats local servers as zero-cost", () => {
    expect(isZeroCostLocalModel("llamacpp", "local.gguf")).toBe(true);
    expect(isZeroCostLocalModel("ollama", "qwen3:8b")).toBe(true);
  });

  it("excludes Ollama Cloud models, which bill remotely", () => {
    expect(isZeroCostLocalModel("ollama", "kimi-k3:cloud")).toBe(false);
  });

  it("never claims zero cost for remote providers", () => {
    expect(isZeroCostLocalModel("openai", "gpt-anything")).toBe(false);
    expect(isZeroCostLocalModel("", "")).toBe(false);
  });
});
