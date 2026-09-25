/** Tests the endpoint projection that feeds the conversation header. */

import type { LLMService } from "@jazz/core/interfaces/llm";
import { describe, expect, it } from "bun:test";
import { hostForModel, resolveLocalModelHosts } from "./local-model-hosts";

describe("local model header host", () => {
  it("uses resolved endpoints and exposes only host:port", () => {
    const resolver = {
      resolveLocalProviderBaseUrl: (provider: "ollama" | "llamacpp" | "vllm" | "sglang") =>
        provider === "vllm"
          ? "https://user:secret@gpu.example:8000/v1?token=hidden"
          : `http://127.0.0.1:${provider === "ollama" ? "11434" : "8080"}/v1`,
    } satisfies Pick<LLMService, "resolveLocalProviderBaseUrl">;
    const hosts = resolveLocalModelHosts(resolver, undefined);
    expect(hostForModel("vllm", "qwen", hosts)).toBe("gpu.example:8000");
    expect(hostForModel("ollama", "llama3", hosts)).toBe("127.0.0.1:11434");
    expect(JSON.stringify(hosts)).not.toContain("secret");
    expect(JSON.stringify(hosts)).not.toContain("hidden");
  });

  it("hides endpoints for cloud and unrecognized providers", () => {
    const hosts = { ollama: "127.0.0.1:11434", vllm: "gpu:8000" };
    expect(hostForModel("ollama", "kimi-k3:cloud", hosts)).toBeUndefined();
    expect(hostForModel("openai", "gpt-5", hosts)).toBeUndefined();
    expect(hostForModel("vllm", "qwen", hosts)).toBe("gpu:8000");
  });
});
