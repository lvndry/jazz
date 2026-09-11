import { describe, expect, it } from "bun:test";
import { CONFIG_VALUE_TYPES, configValueType, parseConfigValue } from "./config-value";

describe("configValueType", () => {
  it("resolves exact paths", () => {
    expect(configValueType("llm.streamIdleTimeoutMs")).toBe("integer");
    expect(configValueType("output.collapseReasoning")).toBe("boolean");
    expect(configValueType("output.streaming.enabled")).toBe("boolean-or-auto");
  });

  it("resolves wildcard segments for per-server MCP overrides", () => {
    expect(configValueType("mcpServers.github.enabled")).toBe("boolean");
    expect(configValueType("mcpServers.some-server.trusted")).toBe("boolean");
  });

  it("does not let a wildcard swallow extra or missing segments", () => {
    expect(configValueType("mcpServers.enabled")).toBeUndefined();
    expect(configValueType("mcpServers.github.nested.enabled")).toBeUndefined();
  });

  it("leaves string settings untyped", () => {
    expect(configValueType("llm.ollama.api_key")).toBeUndefined();
    expect(configValueType("llm.ollama.keep_alive")).toBeUndefined();
    expect(configValueType("logging.level")).toBeUndefined();
    expect(configValueType("storage.path")).toBeUndefined();
  });
});

describe("parseConfigValue", () => {
  it("passes untyped paths through unchanged, preserving exact string content", () => {
    expect(parseConfigValue("llm.ollama.keep_alive", "-1")).toEqual({ ok: true, value: "-1" });
    expect(parseConfigValue("llm.openai.api_key", " sk-abc ")).toEqual({
      ok: true,
      value: " sk-abc ",
    });
  });

  it("parses integers", () => {
    expect(parseConfigValue("llm.streamIdleTimeoutMs", "600000")).toEqual({
      ok: true,
      value: 600000,
    });
    expect(parseConfigValue("maxRetries", " 5 ")).toEqual({ ok: true, value: 5 });
  });

  it("parses fractional numbers where the setting allows them", () => {
    expect(parseConfigValue("context.warnThresholdRatio", "0.7")).toEqual({ ok: true, value: 0.7 });
    expect(parseConfigValue("maxCostUSD", "2.50")).toEqual({ ok: true, value: 2.5 });
  });

  it("rejects a fractional value for an integer setting", () => {
    const result = parseConfigValue("maxRetries", "2.5");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.expected).toBe("a whole number");
  });

  it("rejects numbers with trailing garbage rather than accepting the prefix", () => {
    expect(parseConfigValue("llm.streamIdleTimeoutMs", "600000ms").ok).toBe(false);
    expect(parseConfigValue("maxRetries", "3 retries").ok).toBe(false);
  });

  it("rejects non-numeric and empty values", () => {
    expect(parseConfigValue("maxRetries", "abc").ok).toBe(false);
    expect(parseConfigValue("maxRetries", "").ok).toBe(false);
    expect(parseConfigValue("maxRetries", "   ").ok).toBe(false);
    expect(parseConfigValue("maxRetries", "Infinity").ok).toBe(false);
    expect(parseConfigValue("maxRetries", "NaN").ok).toBe(false);
  });

  it("parses booleans from the literals a person actually types", () => {
    for (const raw of ["true", "TRUE", "yes", "on", "1"]) {
      expect(parseConfigValue("output.collapseReasoning", raw)).toEqual({ ok: true, value: true });
    }
    for (const raw of ["false", "False", "no", "off", "0"]) {
      expect(parseConfigValue("output.collapseReasoning", raw)).toEqual({ ok: true, value: false });
    }
  });

  it("rejects a boolean value it cannot read, instead of storing a live string", () => {
    const result = parseConfigValue("notifications.enabled", "maybe");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.expected).toBe("true or false");
  });

  it("keeps the 'auto' literal for tri-state streaming", () => {
    expect(parseConfigValue("output.streaming.enabled", "auto")).toEqual({
      ok: true,
      value: "auto",
    });
    expect(parseConfigValue("output.streaming.enabled", "false")).toEqual({
      ok: true,
      value: false,
    });
    expect(parseConfigValue("output.streaming.enabled", "sometimes").ok).toBe(false);
  });

  it("types MCP overrides as booleans so the config service records them", () => {
    expect(parseConfigValue("mcpServers.github.enabled", "false")).toEqual({
      ok: true,
      value: false,
    });
    expect(parseConfigValue("mcpServers.github.trusted", "true")).toEqual({
      ok: true,
      value: true,
    });
  });

  it("resolves every declared path back to its declared type", () => {
    for (const [path, type] of Object.entries(CONFIG_VALUE_TYPES)) {
      expect(configValueType(path.replaceAll("*", "example-server"))).toBe(type);
    }
  });
});
