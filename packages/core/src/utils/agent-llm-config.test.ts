import { describe, expect, it } from "bun:test";
import { withAgentProviderOverrides } from "./agent-llm-config";

describe("withAgentProviderOverrides", () => {
  it("returns the global config untouched when the agent overrides nothing", () => {
    const llmConfig = { ollama: { base_url: "http://global:11434" } };
    expect(withAgentProviderOverrides(llmConfig, {})).toBe(llmConfig);
  });

  it("lets the agent's base URL win while keeping the rest of that provider's config", () => {
    const merged = withAgentProviderOverrides(
      { ollama: { base_url: "http://global:11434", keep_alive: "30m" } },
      { baseUrls: { ollama: "http://server:11434" } },
    );
    expect(merged?.ollama).toEqual({ base_url: "http://server:11434", keep_alive: "30m" });
  });

  it("lets the agent's API key win next to its base URL", () => {
    const merged = withAgentProviderOverrides(
      { vllm: { base_url: "http://qwen:8090/v1", api_key: "global-key" } },
      { baseUrls: { vllm: "http://ocr:8150/v1" }, apiKeys: { vllm: "ocr-key" } },
    );
    expect(merged?.vllm).toEqual({ base_url: "http://ocr:8150/v1", api_key: "ocr-key" });
  });

  it("does not touch other providers or mutate the global config", () => {
    const llmConfig = { vllm: { base_url: "http://vllm:8000/v1" } };
    const merged = withAgentProviderOverrides(llmConfig, {
      baseUrls: { ollama: "http://server:11434" },
    });
    expect(merged?.vllm).toEqual({ base_url: "http://vllm:8000/v1" });
    expect(llmConfig).toEqual({ vllm: { base_url: "http://vllm:8000/v1" } });
  });

  it("ignores empty overrides", () => {
    const llmConfig = { ollama: { base_url: "http://global:11434", api_key: "global-key" } };
    const merged = withAgentProviderOverrides(llmConfig, {
      baseUrls: { ollama: "" },
      apiKeys: { ollama: "" },
    });
    expect(merged?.ollama).toEqual({ base_url: "http://global:11434", api_key: "global-key" });
  });
});
