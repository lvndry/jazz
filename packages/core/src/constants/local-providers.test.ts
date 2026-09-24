import { describe, expect, it } from "bun:test";
import {
  isLocalServerProvider,
  isZeroCostLocalModel,
  LOCAL_MODEL_PROVIDERS,
  localServerAddress,
} from "./local-providers";

describe("LOCAL_MODEL_PROVIDERS", () => {
  it("lists exactly the local model servers", () => {
    expect(LOCAL_MODEL_PROVIDERS).toEqual(["llamacpp", "ollama"]);
    expect(isLocalServerProvider("llamacpp")).toBe(true);
    expect(isLocalServerProvider("openai")).toBe(false);
  });
});

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

describe("localServerAddress", () => {
  it("drops the REST path a stored base URL carries", () => {
    expect(localServerAddress("http://127.0.0.1:8090/v1")).toBe("http://127.0.0.1:8090");
    expect(localServerAddress("http://gpu.example:11434/api/")).toBe("http://gpu.example:11434");
  });

  it("keeps a custom reverse-proxy path", () => {
    expect(localServerAddress("https://proxy.example/llama")).toBe("https://proxy.example/llama");
  });
});
