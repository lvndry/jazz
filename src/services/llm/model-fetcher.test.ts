import { afterAll, describe, expect, it, mock, beforeEach } from "bun:test";
import { Effect } from "effect";
import type { ModelsDevMetadata } from "@/core/utils/models-dev-client";
import { createModelFetcher, resolveOllamaToolSupport, type OllamaModel } from "./model-fetcher";

// Mock models-dev-client
mock.module("@/core/utils/models-dev-client", () => ({
  getModelsDevMap: mock(() => Promise.resolve(new Map())),
  getMetadataFromMap: mock(() => null),
}));

/**
 * Install a `global.fetch` mock for an ollama model fetch: `/api/tags` → `tags`,
 * `/api/show` → `show` (200), anything else → 404. Returns the array of requested
 * URLs (populated as fetch is invoked) so callers can assert which URLs were hit.
 */
function mockOllamaFetch(responses: { tags: unknown; show: unknown }): string[] {
  const requestedUrls: string[] = [];
  global.fetch = mock((url: string) => {
    requestedUrls.push(url);
    if (url.endsWith("/api/tags"))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(responses.tags) });
    if (url.endsWith("/api/show"))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responses.show),
      });
    return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
  }) as unknown as typeof fetch;
  return requestedUrls;
}

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

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
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

  it("captures template and capabilities from ollama /api/show onto every ModelInfo", async () => {
    const mockTagsResponse = {
      models: [{ name: "qwen3:8b", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "qwen3.context_length": 32768 },
      template: "{{ if .Thinking }}<think>{{ end }}",
      capabilities: ["completion", "tools", "thinking"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.chatTemplate).toBe("{{ if .Thinking }}<think>{{ end }}");
    expect(result[0]!.capabilities).toEqual(["completion", "tools", "thinking"]);
    expect(result[0]!.isReasoningModel).toBe(true);
  });

  it("sets supportsTools=true for a thinking ollama model whose /api/show capabilities include tools (gemma4 regression)", async () => {
    const mockTagsResponse = {
      models: [{ name: "gemma4:26b-a4b-it-q4_K_M", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "gemma3.context_length": 131072 },
      template: "{{ if .Thinking }}<think>{{ end }}",
      capabilities: ["completion", "vision", "tools", "thinking"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.isReasoningModel).toBe(true);
    expect(result[0]!.supportsTools).toBe(true);
  });

  // Base-URL canonicalization (bare host → /api root) lives in resolveLocalProviderBaseUrl and is
  // covered in base-url-resolver.test.ts. Here the base is already the canonical /api root, so this
  // asserts the endpoints append correctly: /show (not /api/api/show) and /tags.
  it("reaches /api/show (not /api/api/show) from the canonical /api-root base URL", async () => {
    const requestedUrls = mockOllamaFetch({
      tags: { models: [{ name: "qwen3.6:27b", details: { metadata: {} } }] },
      show: {
        model_info: { "qwen3.context_length": 262144 },
        template: "{{ if .Thinking }}<think>{{ end }}",
        capabilities: ["completion", "vision", "tools", "thinking"],
      },
    });

    const result = await Effect.runPromise(
      fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags"),
    );

    expect(requestedUrls).toContain("http://localhost:11434/api/show");
    expect(requestedUrls.some((url) => url.includes("/api/api/"))).toBe(false);
    expect(result.length).toBe(1);
    expect(result[0]!.capabilities).toEqual(["completion", "vision", "tools", "thinking"]);
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("sets supportsTools=false for an ollama model whose /api/show capabilities omit tools", async () => {
    const mockTagsResponse = {
      models: [{ name: "embeddinggemma:300m", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "gemma3.context_length": 2048 },
      capabilities: ["completion"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTools).toBe(false);
  });

  it("trusts capabilities over legacy metadata: capabilities without tools wins even if metadata claims supports_tools", async () => {
    const mockTagsResponse = {
      models: [{ name: "embeddinggemma:300m", details: { metadata: { supports_tools: true } } }],
    };
    const mockShowResponse = {
      model_info: { "gemma3.context_length": 2048 },
      capabilities: ["completion"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTools).toBe(false);
  });

  it("sets isReasoningModel=false for ollama models without thinking capability or tag template", async () => {
    const mockTagsResponse = {
      models: [{ name: "llama3.1:8b", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "llama.context_length": 131072 },
      template: "{{ .System }}{{ .Prompt }}",
      capabilities: ["completion", "tools"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result[0]!.isReasoningModel).toBe(false);
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
    expect(result[0]!.isReasoningModel).toBe(true);
  });

  it("sets isReasoningModel=false for llama.cpp models without reasoning markers in chat_template", async () => {
    const mockModelsResponse = { data: [{ id: "llama-3.1-8b" }] };
    const mockPropsResponse = {
      default_generation_settings: { n_ctx: 8192 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: true },
      chat_template: "{% for m in messages %}{{ m.content }}{% endfor %}",
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

    expect(result[0]!.isReasoningModel).toBe(false);
  });

  it("run-path seam: ollama model not in models.dev with tools capability resolves supportsTools=true", async () => {
    const mockTagsResponse = {
      models: [{ name: "qwen3.6:27b", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "qwen3.context_length": 32768 },
      capabilities: ["completion", "tools", "thinking"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("run-path seam: ollama model whose capabilities omit tools resolves supportsTools=false", async () => {
    const mockTagsResponse = {
      models: [{ name: "embeddinggemma:300m", details: { metadata: {} } }],
    };
    const mockShowResponse = {
      model_info: { "gemma3.context_length": 2048 },
      capabilities: ["completion"],
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTools).toBe(false);
  });

  describe("resolveOllamaToolSupport", () => {
    const noMetadataModel: OllamaModel = { name: "model:tag", details: { metadata: {} } };
    const toolCapableDev: ModelsDevMetadata = {
      contextWindow: 32768,
      supportsTools: true,
      isReasoningModel: false,
      supportsVision: false,
      supportsPdf: false,
    };
    const nonToolDev: ModelsDevMetadata = { ...toolCapableDev, supportsTools: false };

    it("trusts /api/show capabilities over a stale models.dev tool_call=false (run-path gap)", () => {
      expect(resolveOllamaToolSupport(["completion", "tools"], nonToolDev, noMetadataModel)).toBe(
        true,
      );
    });

    it("drops tools when capabilities omit tools even if models.dev claims tool_call=true", () => {
      expect(resolveOllamaToolSupport(["completion"], toolCapableDev, noMetadataModel)).toBe(false);
    });

    it("falls back to models.dev tool_call when /api/show capabilities are absent", () => {
      expect(resolveOllamaToolSupport(undefined, toolCapableDev, noMetadataModel)).toBe(true);
      expect(resolveOllamaToolSupport(undefined, nonToolDev, noMetadataModel)).toBe(false);
    });

    it("falls back to legacy manifest metadata when neither capabilities nor models.dev are present", () => {
      const metadataModel: OllamaModel = {
        name: "legacy:tag",
        details: { metadata: { supports_tools: true } },
      };
      expect(resolveOllamaToolSupport(undefined, undefined, metadataModel)).toBe(true);
      expect(resolveOllamaToolSupport(undefined, undefined, noMetadataModel)).toBe(false);
    });
  });
});
