import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LLMConfig } from "@/core/types";
import { resolveLocalProviderBaseUrl } from "./models";

describe("resolveLocalProviderBaseUrl", () => {
  const ENV_VARS = ["LLAMACPP_BASE_URL", "OLLAMA_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of ENV_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("returns the llamacpp default when nothing configured", () => {
    expect(resolveLocalProviderBaseUrl("llamacpp")).toBe("http://localhost:8080/v1");
  });

  it("returns the ollama default when nothing configured", () => {
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://localhost:11434/api");
  });

  it("uses LLAMACPP_BASE_URL env var over default", () => {
    process.env["LLAMACPP_BASE_URL"] = "http://env-host:9000/v1";
    expect(resolveLocalProviderBaseUrl("llamacpp")).toBe("http://env-host:9000/v1");
  });

  it("uses OLLAMA_BASE_URL env var over default", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434/api";
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://env-host:11434/api");
  });

  it("config base_url overrides env var for llamacpp", () => {
    process.env["LLAMACPP_BASE_URL"] = "http://env-host:9000/v1";
    const config: LLMConfig = { llamacpp: { base_url: "http://config-host:9090/v1" } };
    expect(resolveLocalProviderBaseUrl("llamacpp", config)).toBe("http://config-host:9090/v1");
  });

  it("config base_url overrides env var for ollama", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434/api";
    const config: LLMConfig = { ollama: { base_url: "http://config-host:11434/api" } };
    expect(resolveLocalProviderBaseUrl("ollama", config)).toBe("http://config-host:11434/api");
  });

  it("ignores empty string config values and falls through", () => {
    const config: LLMConfig = { llamacpp: { base_url: "" } };
    expect(resolveLocalProviderBaseUrl("llamacpp", config)).toBe("http://localhost:8080/v1");
  });
});
