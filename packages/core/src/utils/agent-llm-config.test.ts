import { describe, expect, it } from "bun:test";
import { withAgentBaseUrls } from "./agent-llm-config";

describe("withAgentBaseUrls", () => {
  it("returns the global config untouched when the agent sets no base URLs", () => {
    const llmConfig = { ollama: { base_url: "http://global:11434" } };
    expect(withAgentBaseUrls(llmConfig, undefined)).toBe(llmConfig);
  });

  it("lets the agent's base URL win while keeping the rest of that provider's config", () => {
    const merged = withAgentBaseUrls(
      { ollama: { base_url: "http://global:11434", keep_alive: "30m" } },
      { ollama: "http://server:11434" },
    );
    expect(merged?.ollama).toEqual({ base_url: "http://server:11434", keep_alive: "30m" });
  });

  it("does not touch other providers or mutate the global config", () => {
    const llmConfig = { vllm: { base_url: "http://vllm:8000/v1" } };
    const merged = withAgentBaseUrls(llmConfig, { ollama: "http://server:11434" });
    expect(merged?.vllm).toEqual({ base_url: "http://vllm:8000/v1" });
    expect(llmConfig).toEqual({ vllm: { base_url: "http://vllm:8000/v1" } });
  });

  it("ignores empty overrides", () => {
    const llmConfig = { ollama: { base_url: "http://global:11434" } };
    expect(withAgentBaseUrls(llmConfig, { ollama: "" })?.ollama?.base_url).toBe(
      "http://global:11434",
    );
  });
});
