import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LLMConfig } from "@/core/types";
import {
  OLLAMA_CLOUD_API_ROOT,
  resolveLocalProviderBaseUrl,
  resolveOllamaRequestBaseUrl,
} from "./models";

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

  it("canonicalizes an ollama env base URL without /api to the /api root", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434";
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://env-host:11434/api");
  });

  it("canonicalizes an ollama config base URL without /api to the /api root", () => {
    const config: LLMConfig = { ollama: { base_url: "http://config-host:11434" } };
    expect(resolveLocalProviderBaseUrl("ollama", config)).toBe("http://config-host:11434/api");
  });

  it("strips a trailing slash and keeps a single /api root for ollama", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434/api/";
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://env-host:11434/api");
  });

  it("does NOT force /api onto llamacpp (its convention is /v1, not /api)", () => {
    process.env["LLAMACPP_BASE_URL"] = "http://env-host:9000";
    expect(resolveLocalProviderBaseUrl("llamacpp")).toBe("http://env-host:9000");
  });
});

describe("resolveOllamaRequestBaseUrl", () => {
  const ENV_VARS = ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"] as const;
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

  it("keeps local models on the local daemon", () => {
    expect(resolveOllamaRequestBaseUrl("llama3.2", { ollama: { api_key: "ollama-key" } })).toBe(
      "http://localhost:11434/api",
    );
  });

  it("sends a cloud model with an API key to ollama.com, not localhost", () => {
    expect(
      resolveOllamaRequestBaseUrl("kimi-k3:cloud", { ollama: { api_key: "ollama-key" } }),
    ).toBe(OLLAMA_CLOUD_API_ROOT);
  });

  it("leaves a cloud model on localhost when no key is configured (ollama signin path)", () => {
    expect(resolveOllamaRequestBaseUrl("kimi-k3:cloud")).toBe("http://localhost:11434/api");
  });

  it("still honours a non-loopback base_url for cloud models", () => {
    expect(
      resolveOllamaRequestBaseUrl("kimi-k3:cloud", {
        ollama: { api_key: "ollama-key", base_url: "https://proxy.example/api" },
      }),
    ).toBe("https://proxy.example/api");
  });

  it("overrides a loopback base_url for cloud models when a key is set", () => {
    expect(
      resolveOllamaRequestBaseUrl("gpt-oss:120b-cloud", {
        ollama: { api_key: "ollama-key", base_url: "http://127.0.0.1:11434" },
      }),
    ).toBe(OLLAMA_CLOUD_API_ROOT);
  });

  it("picks up OLLAMA_API_KEY from the environment", () => {
    process.env["OLLAMA_API_KEY"] = "env-key";
    expect(resolveOllamaRequestBaseUrl("kimi-k3:cloud")).toBe(OLLAMA_CLOUD_API_ROOT);
  });
});
