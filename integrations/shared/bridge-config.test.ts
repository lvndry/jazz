import { describe, expect, it } from "bun:test";
import { mergeBridgeConfig } from "./bridge-config";

describe("mergeBridgeConfig", () => {
  it("preserves keys the operator added to the file", () => {
    const { config } = mergeBridgeConfig(
      { tools: { shell: { timeout: 99 } }, llm: { anthropic: { api_key: "sk-op" } } },
      { ollamaKeepAlive: "-1" },
    );
    expect(config["tools"]).toEqual({ shell: { timeout: 99 } });
    expect((config["llm"] as Record<string, unknown>)["anthropic"]).toEqual({ api_key: "sk-op" });
  });

  it("sets ollama keep_alive alongside a sibling provider", () => {
    const { config, applied } = mergeBridgeConfig(
      { llm: { anthropic: { api_key: "sk-op" } } },
      { ollamaKeepAlive: "30m" },
    );
    expect((config["llm"] as Record<string, unknown>)["ollama"]).toEqual({ keep_alive: "30m" });
    expect(applied).toContain("ollama.keep_alive=30m");
  });

  it("removes keep_alive when the variable goes away, keeping other ollama keys", () => {
    const { config } = mergeBridgeConfig(
      { llm: { ollama: { keep_alive: "-1", base_url: "http://host:11434" } } },
      {},
    );
    expect((config["llm"] as Record<string, unknown>)["ollama"]).toEqual({
      base_url: "http://host:11434",
    });
  });

  it("drops the llm key entirely once nothing is left under it", () => {
    const { config, applied } = mergeBridgeConfig({ llm: { ollama: { keep_alive: "-1" } } }, {});
    expect(config).not.toHaveProperty("llm");
    expect(applied).toEqual([]);
  });

  it("configures brave web search from the key", () => {
    const { config, applied } = mergeBridgeConfig({}, { braveApiKey: "brv" });
    expect(config["web_search"]).toEqual({
      provider: "brave",
      brave: { api_key: "brv" },
    });
    expect(applied).toContain("web_search=brave");
  });

  it("removes web_search when the key goes away, so disabling it takes effect", () => {
    const { config } = mergeBridgeConfig(
      { web_search: { provider: "brave", brave: { api_key: "old" } } },
      {},
    );
    expect(config).not.toHaveProperty("web_search");
  });

  it("does not mutate the input", () => {
    const existing = { llm: { ollama: { keep_alive: "5m" } } };
    mergeBridgeConfig(existing, { ollamaKeepAlive: "-1" });
    expect(existing.llm.ollama.keep_alive).toBe("5m");
  });
});
