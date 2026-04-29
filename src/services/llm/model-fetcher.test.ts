import { afterAll, describe, expect, it, mock, beforeEach } from "bun:test";
import { Effect } from "effect";
import { createModelFetcher } from "./model-fetcher";

// Mock models-dev-client
mock.module("@/core/utils/models-dev-client", () => ({
  getModelsDevMap: mock(() => Promise.resolve(new Map())),
  getMetadataFromMap: mock(() => null),
}));

describe("ModelFetcher", () => {
  const fetcher = createModelFetcher();

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    // Reset global fetch mock if needed
  });

  it("should fetch models from OpenRouter", async () => {
    const mockResponse = {
      data: [{ id: "m1", name: "Model 1", context_length: 8192, supported_parameters: ["tools"] }],
    };

    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    ) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/models", "key");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("m1");
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("should handle Ollama with special transformation", async () => {
    const mockTagsResponse = {
      models: [{ name: "llama3:latest", details: { metadata: { supports_tools: true } } }],
    };
    const mockShowResponse = {
      model_info: { "llama.context_length": 4096 },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434", "/api/tags");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("llama3:latest");
    expect(result[0]!.contextWindow).toBe(4096);
  });

  it("should fail gracefully on 404", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    ) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/bad");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
  });

  it("fetches llama.cpp models with /v1/models + /props (happy path)", async () => {
    const modelsResponse = { data: [{ id: "qwen2.5-coder-32b" }] };
    const propsResponse = {
      default_generation_settings: { n_ctx: 32768 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: true },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(propsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("qwen2.5-coder-32b");
    expect(result[0]!.contextWindow).toBe(32768);
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("falls back to defaults when llama.cpp /props is unreachable", async () => {
    const modelsResponse = { data: [{ id: "tinyllama" }] };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("tinyllama");
    expect(result[0]!.contextWindow).toBe(128_000);
    expect(result[0]!.supportsTools).toBe(false);
  });

  it("requires both supports_tools and supports_tool_calls in chat_template_caps", async () => {
    const modelsResponse = { data: [{ id: "partial-tools" }] };
    const propsResponse = {
      default_generation_settings: { n_ctx: 4096 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: false },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(propsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTools).toBe(false);
    expect(result[0]!.contextWindow).toBe(4096);
  });

  it("returns a friendly error when llama.cpp has no model loaded", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const msg = String(result.cause);
      expect(msg).toMatch(/no models loaded|llama-server/i);
    }
  });

  it("captures chat_template from llama.cpp /props onto every ModelInfo", async () => {
    const mockModelsResponse = { data: [{ id: "qwen3-4b" }] };
    const mockPropsResponse = {
      default_generation_settings: { n_ctx: 8192 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: true },
      chat_template: "{% if reasoning %}<think>{% endif %}",
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockModelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockPropsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.chatTemplate).toBe("{% if reasoning %}<think>{% endif %}");
  });
});
