/**
 * Exercises provider model discovery and local-server metadata probes with controlled responses.
 * Ollama concurrency fixtures cover reuse-window replacement, independent caller cancellation,
 * and listener cleanup without depending on a live model server or provider credentials.
 */
import type { ModelsDevMetadata, ModelsDevModelEntry } from "@jazz/core/utils/models-dev";
import { afterAll, describe, expect, it, mock, beforeEach, spyOn } from "bun:test";
import { Effect } from "effect";
import {
  clearOllamaProbeCache,
  createModelFetcher,
  fetchLlamaCppServerModel,
  fetchOllamaModelDetails,
  fetchOllamaRunningContextWindow,
  fetchSglangServerModel,
  LOCAL_SERVER_PROBE_TIMEOUT_MS,
  fetchVllmServerModel,
  fetchModelsDevModels,
  resolveOllamaToolSupport,
  type OllamaModel,
} from "./model-fetcher";

beforeEach(() => {
  clearOllamaProbeCache();
});

function modelsDevEntry(
  overrides: Partial<ModelsDevModelEntry> & { id: string },
): ModelsDevModelEntry {
  return {
    displayName: overrides.id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    metadata: {
      contextWindow: 200000,
      supportsTools: true,
      isReasoningModel: false,
      ingestImage: false,
      ingestPdf: false,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
    },
    ...overrides,
  };
}

let modelsDevProviderModels: readonly ModelsDevModelEntry[] = [];
let modelsDevProviderError: Error | null = null;
/** Catalog metadata every model resolves to, so tests can pit models.dev against a local server. */
let modelsDevMetadata: ModelsDevMetadata | null = null;

// Bun module mocks are process-global: snapshot the real exports so afterAll can
// restore them for test files that run later in the same process.
const actualModelsDevModule = {
  ...(await import("@jazz/core/utils/models-dev")),
};

// Mock the models.dev catalog module
mock.module("@jazz/core/utils/models-dev", () => ({
  getModelsDevMap: mock(() => Promise.resolve(new Map())),
  getMetadataFromMap: mock(() => modelsDevMetadata),
  getModelsDevProviderModels: mock(() => {
    if (modelsDevProviderError) return Promise.reject(modelsDevProviderError);
    return Promise.resolve(modelsDevProviderModels);
  }),
}));

// `global.fetch` is assigned directly below, which `mock.restore()` does not
// undo. Snapshot it so later test files in the same process still see real fetch.
const actualFetch = globalThis.fetch;

afterAll(() => {
  mock.module("@jazz/core/utils/models-dev", () => actualModelsDevModule);
  globalThis.fetch = actualFetch;
});

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
    modelsDevMetadata = null;
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

  it("lists NVIDIA NIM chat models live, dropping embedding, guardrail and parser models", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "deepseek-ai/deepseek-v4.1-flash" },
              { id: "nvidia/nv-embedqa-mistral-7b-v2" },
              { id: "nvidia/llama-3.1-nemoguard-8b-content-safety" },
              { id: "nvidia/nemotron-parse" },
              { id: "nvidia/nemotron-4-340b-reward" },
              { id: "meta/llama-3.3-70b-instruct" },
            ],
          }),
      }),
    ) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetcher.fetchModels("nvidia", "https://integrate.api.nvidia.com", "/v1/models", "nvapi-key"),
    );

    expect(result.map((model) => model.id)).toEqual([
      "deepseek-ai/deepseek-v4.1-flash",
      "meta/llama-3.3-70b-instruct",
    ]);
  });

  it("scopes catalog metadata to the listing provider before any other host's entry", async () => {
    const { getMetadataFromMap } = await import("@jazz/core/utils/models-dev");
    const lookup = getMetadataFromMap as unknown as ReturnType<typeof mock>;
    lookup.mockClear();
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "deepseek-ai/deepseek-v4-flash" }] }),
      }),
    ) as unknown as typeof fetch;

    await Effect.runPromise(
      fetcher.fetchModels("nvidia", "https://integrate.api.nvidia.com", "/v1/models"),
    );

    expect(lookup).toHaveBeenCalledWith(
      expect.anything(),
      "deepseek-ai/deepseek-v4-flash",
      "nvidia",
      { anyProvider: false },
    );
  });

  it("keeps another host's model traits but not its price when the provider lists no entry", async () => {
    const { getMetadataFromMap } = await import("@jazz/core/utils/models-dev");
    const lookup = getMetadataFromMap as unknown as ReturnType<typeof mock>;
    const otherHost = {
      ...modelsDevEntry({ id: "deepseek-ai/deepseek-v4.1-flash" }).metadata,
      contextWindow: 1_048_576,
      inputPricePerMillion: 0.3,
      outputPricePerMillion: 1.2,
    };
    lookup.mockImplementation(
      (_map: unknown, _id: string, _provider?: string, options?: { anyProvider?: boolean }) =>
        options?.anyProvider === false ? undefined : otherHost,
    );
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "deepseek-ai/deepseek-v4.1-flash" }] }),
      }),
    ) as unknown as typeof fetch;

    try {
      const [model] = await Effect.runPromise(
        fetcher.fetchModels("nvidia", "https://integrate.api.nvidia.com", "/v1/models"),
      );

      expect(model).toMatchObject({ contextWindow: 1_048_576, supportsTools: true });
      expect(model?.inputPricePerMillion).toBeUndefined();
      expect(model?.outputPricePerMillion).toBeUndefined();
    } finally {
      lookup.mockImplementation(() => modelsDevMetadata);
    }
  });

  it("looks Fireworks models up under models.dev's fireworks-ai listing", async () => {
    const { getMetadataFromMap } = await import("@jazz/core/utils/models-dev");
    const lookup = getMetadataFromMap as unknown as ReturnType<typeof mock>;
    lookup.mockClear();
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                name: "accounts/fireworks/models/kimi-k2",
                state: "READY",
                conversationConfig: {},
                supportsServerless: true,
              },
            ],
          }),
      }),
    ) as unknown as typeof fetch;

    await Effect.runPromise(
      fetcher.fetchModels("fireworks", "https://api.fireworks.ai", "/v1/accounts/fireworks/models"),
    );

    expect(lookup).toHaveBeenCalledWith(
      expect.anything(),
      "accounts/fireworks/models/kimi-k2",
      "fireworks-ai",
      { anyProvider: false },
    );
  });

  it("lists vLLM models with their served context windows without probing llama.cpp /props", async () => {
    const requestedUrls: string[] = [];
    global.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "served-a", max_model_len: 32768 },
              { id: "served-b", max_model_len: 65536 },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    const models = await Effect.runPromise(
      fetcher.fetchModels("vllm", "http://localhost:8000/v1", "/models"),
    );

    expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
      ["served-a", 32768],
      ["served-b", 65536],
    ]);
    expect(models.every((model) => model.supportsTools)).toBe(true);
    expect(requestedUrls).toEqual(["http://localhost:8000/v1/models"]);
  });

  it("lists SGLang base and LoRA models with the served context window", async () => {
    const requestedUrls: string[] = [];
    global.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "base", max_model_len: 32768 },
              { id: "adapter", parent: "base", max_model_len: null },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    const models = await Effect.runPromise(
      fetcher.fetchModels("sglang", "http://localhost:30000/v1", "/models"),
    );
    expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
      ["base", 32768],
      ["adapter", 32768],
    ]);
    expect(models.every((model) => model.supportsTools)).toBe(true);
    expect(requestedUrls).toEqual(["http://localhost:30000/v1/models"]);
  });

  it("selects the current SGLang model, falling back when the saved ID disappears", async () => {
    const authorizations: Array<string | null> = [];
    global.fetch = mock((_url: string, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "new-base", max_model_len: 16384 },
              { id: "lora", parent: "new-base", max_model_len: null },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    expect(await fetchSglangServerModel("http://localhost:30000/v1", "lora", "secret")).toEqual({
      modelId: "lora",
      contextWindow: 16384,
    });
    expect(await fetchSglangServerModel("http://localhost:30000/v1", "old-base")).toEqual({
      modelId: "new-base",
      contextWindow: 16384,
    });
    expect(authorizations).toEqual(["Bearer secret", null]);
  });

  it("reports missing and protected SGLang servers at model discovery", async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }),
    ) as unknown as typeof fetch;
    expect(await fetchSglangServerModel("http://localhost:30000/v1", "old")).toEqual({});
    await expect(
      Effect.runPromise(fetcher.fetchModels("sglang", "http://localhost:30000/v1", "/models")),
    ).rejects.toThrow("No models loaded");

    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;
    await expect(
      Effect.runPromise(fetcher.fetchModels("sglang", "http://localhost:30000/v1", "/models")),
    ).rejects.toThrow("needs an API key");
  });

  it("uses vLLM's served context limit over catalog metadata while retaining catalog tool support", async () => {
    modelsDevMetadata = {
      contextWindow: 200000,
      supportsTools: false,
      isReasoningModel: false,
      ingestImage: false,
      ingestPdf: false,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
    };
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "served", max_model_len: 8192 }] }),
      }),
    ) as unknown as typeof fetch;

    const models = await Effect.runPromise(
      fetcher.fetchModels("vllm", "http://localhost:8000/v1", "/models"),
    );
    expect(models[0]?.contextWindow).toBe(8192);
    expect(models[0]?.supportsTools).toBe(false);
  });

  it("prefers a selected vLLM model among several, then falls back to the first live ID", async () => {
    const authorizations: Array<string | null> = [];
    global.fetch = mock((_url: string, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "other", max_model_len: 2048 },
              { id: "configured", max_model_len: 16384 },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    expect(await fetchVllmServerModel("http://localhost:8000/v1", "configured", "secret")).toEqual({
      modelId: "configured",
      contextWindow: 16384,
    });
    expect(authorizations).toEqual(["Bearer secret"]);
    expect(await fetchVllmServerModel("http://localhost:8000/v1", "removed")).toEqual({
      modelId: "other",
      contextWindow: 2048,
    });
  });

  it("reports an empty vLLM model list instead of selecting a stale ID", async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }),
    ) as unknown as typeof fetch;

    expect(await fetchVllmServerModel("http://localhost:8000/v1", "stale")).toEqual({});
    await expect(
      Effect.runPromise(fetcher.fetchModels("vllm", "http://localhost:8000/v1", "/models")),
    ).rejects.toThrow("No models loaded");
  });

  it("ignores malformed vLLM model cards before choosing the live ID and window", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "", max_model_len: 999999 },
              { id: 42, max_model_len: 999999 },
              { id: "served", max_model_len: -1 },
              { id: "next", max_model_len: 8192 },
            ],
          }),
      }),
    ) as unknown as typeof fetch;

    expect(await fetchVllmServerModel("http://localhost:8000/v1", "absent")).toEqual({
      modelId: "served",
    });
    expect(await fetchVllmServerModel("http://localhost:8000/v1", "next")).toEqual({
      modelId: "next",
      contextWindow: 8192,
    });
  });

  it("flags an authenticated vLLM server when model listing is unauthorized", async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;

    expect(await fetchVllmServerModel("http://localhost:8000/v1", "served")).toEqual({});
    await expect(
      Effect.runPromise(fetcher.fetchModels("vllm", "http://localhost:8000/v1", "/models")),
    ).rejects.toThrow("needs an API key");
  });

  it("sets supportsTemperature=true for an OpenRouter model whose supported_parameters include temperature", async () => {
    const mockResponse = {
      data: [
        {
          id: "m2",
          name: "Model 2",
          context_length: 8192,
          supported_parameters: ["tools", "temperature"],
        },
      ],
    };

    global.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(mockResponse) }),
    ) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/models", "key");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTemperature).toBe(true);
  });

  it("sets supportsTemperature=false for an OpenRouter model whose supported_parameters omit temperature (e.g. o-series reasoners)", async () => {
    const mockResponse = {
      data: [
        {
          id: "o3",
          name: "o3",
          context_length: 200000,
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    };

    global.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(mockResponse) }),
    ) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/models", "key");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTemperature).toBe(false);
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
    expect(result[0]!.supportsTemperature).toBe(true);
  });

  it("reads Ollama's server-wide /api/ps once however many models are installed", async () => {
    const requestedUrls: string[] = [];
    global.fetch = mock((url: string) => {
      requestedUrls.push(url);
      if (url.endsWith("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              models: ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({
                name: `${name}:latest`,
              })),
            }),
        });
      }
      if (url.endsWith("/api/ps")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: "c:latest", context_length: 16384 }] }),
        });
      }
      if (url.endsWith("/api/show")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ model_info: { "llama.context_length": 4096 } }),
        });
      }
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags"),
    );

    expect(requestedUrls.filter((url) => url.endsWith("/api/ps"))).toHaveLength(1);
    expect(requestedUrls.filter((url) => url.endsWith("/api/show"))).toHaveLength(7);
    expect(result).toHaveLength(7);
  });

  it("reports the window llama-server was started with, not the catalog maximum", async () => {
    modelsDevMetadata = {
      contextWindow: 262144,
      supportsTools: true,
      isReasoningModel: false,
      ingestImage: false,
      ingestPdf: false,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
    };
    const modelsResponse = { data: [{ id: "qwen3.6-27b" }] };
    const propsResponse = {
      default_generation_settings: { n_ctx: 131072 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: true },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(propsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models"),
    );

    expect(result[0]!.contextWindow).toBe(131072);
  });

  it("reports the context length of the Ollama model on this host, not the catalog's", async () => {
    modelsDevMetadata = {
      contextWindow: 1000000,
      supportsTools: true,
      isReasoningModel: false,
      ingestImage: false,
      ingestPdf: false,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
    };

    mockOllamaFetch({
      tags: { models: [{ name: "qwen3.6:27b" }] },
      show: { model_info: { "qwen35.context_length": 262144 }, capabilities: ["tools"] },
    });

    const result = await Effect.runPromise(
      fetcher.fetchModels("ollama", "http://localhost:11434/api", "/tags"),
    );

    expect(result[0]!.contextWindow).toBe(262144);
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

  it("flags a llama.cpp server that rejects the request as needing an API key", async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://127.0.0.1:8090/v1", "/models");
    const result = await Effect.runPromise(Effect.flip(program));

    expect(result.reason).toBe("unauthorized");
    expect(result.message).toContain("http://127.0.0.1:8090 rejected the request (401)");
  });

  it("sends the API key to /props as well as /v1/models", async () => {
    const authorizationByPath: Record<string, string | undefined> = {};
    global.fetch = mock((url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authorizationByPath[new URL(url).pathname] = headers?.["Authorization"];
      if (url.endsWith("/v1/models")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: "m" }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    await Effect.runPromise(
      fetcher.fetchModels("llamacpp", "http://127.0.0.1:8090/v1", "/models", "secret"),
    );

    expect(authorizationByPath).toEqual({
      "/v1/models": "Bearer secret",
      "/props": "Bearer secret",
    });
  });

  it("returns an actionable error when the llama.cpp server is unreachable", async () => {
    global.fetch = mock(() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const msg = String(result.cause);
      expect(msg).toMatch(/llama-server/i);
      expect(msg).not.toMatch(/model discovery failed/i);
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
      ingestImage: false,
      ingestPdf: false,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
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

  describe("fetchModelsDevModels", () => {
    beforeEach(() => {
      modelsDevProviderModels = [];
      modelsDevProviderError = null;
    });

    it("maps catalog entries to ModelInfo with their metadata", async () => {
      modelsDevProviderModels = [
        modelsDevEntry({
          id: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          metadata: {
            contextWindow: 1000000,
            supportsTools: true,
            isReasoningModel: true,
            ingestImage: true,
            ingestPdf: true,
            ingestAudio: false,
            ingestVideo: false,
            generatesImage: false,
            generatesAudio: false,
            generatesVideo: false,
            supportsTemperature: false,
          },
        }),
      ];

      const result = await fetchModelsDevModels("anthropic");

      expect(result).toEqual([
        {
          id: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          contextWindow: 1000000,
          supportsTools: true,
          isReasoningModel: true,
          ingestImage: true,
          ingestPdf: true,
          ingestAudio: false,
          ingestVideo: false,
          generatesImage: false,
          generatesAudio: false,
          generatesVideo: false,
          supportsTemperature: false,
        },
      ]);
    });

    it("drops deprecated models", async () => {
      modelsDevProviderModels = [
        modelsDevEntry({ id: "current-model" }),
        modelsDevEntry({ id: "old-model", status: "deprecated" }),
        modelsDevEntry({ id: "preview-model", status: "beta" }),
      ];

      const ids = (await fetchModelsDevModels("openai")).map((model) => model.id);

      expect(ids).toContain("current-model");
      expect(ids).toContain("preview-model");
      expect(ids).not.toContain("old-model");
    });

    it("drops anything you cannot hold a conversation with", async () => {
      // Text in and text out is the whole test, and it covers every case this filter exists for.
      modelsDevProviderModels = [
        modelsDevEntry({ id: "chat-model" }),
        modelsDevEntry({ id: "embedding-model", outputModalities: [] }),
        // TTS: takes text, returns only audio.
        modelsDevEntry({ id: "tts-model", outputModalities: ["audio"] }),
        // Transcription (whisper-class): takes only audio, returns text.
        modelsDevEntry({
          id: "transcription-model",
          inputModalities: ["audio"],
          outputModalities: ["text"],
        }),
        // A pure generator (gpt-image-1): prompt in, image out, nothing to talk to.
        modelsDevEntry({ id: "pure-image-generator", outputModalities: ["image"] }),
        modelsDevEntry({ id: "vision-only-input", inputModalities: ["image"] }),
      ];

      const ids = (await fetchModelsDevModels("openai")).map((model) => model.id);

      expect(ids).toEqual(["chat-model"]);
    });

    it("keeps a chat model that also emits media", async () => {
      // The reason the blanket media-output exclusion was removed. gemini-3-pro-image and
      // gpt-image-1.5 converse normally and can also return an image; hiding them made it
      // impossible to run an agent on a model that generates images, which is the only way jazz
      // offers image generation — it is a model capability, not a tool.
      modelsDevProviderModels = [
        modelsDevEntry({ id: "image-chat-model", outputModalities: ["text", "image"] }),
        modelsDevEntry({ id: "audio-chat-model", outputModalities: ["text", "audio"] }),
      ];

      const ids = (await fetchModelsDevModels("google")).map((model) => model.id);

      // Order-independent: the listing sorts by release date then id, which is unrelated to
      // what this test is about.
      expect([...ids].sort()).toEqual(["audio-chat-model", "image-chat-model"]);
    });

    it("drops dated snapshot duplicates only when the undated base id exists", async () => {
      modelsDevProviderModels = [
        modelsDevEntry({ id: "claude-haiku-4-5" }),
        modelsDevEntry({ id: "claude-haiku-4-5-20251001" }),
        modelsDevEntry({ id: "gpt-4o" }),
        modelsDevEntry({ id: "gpt-4o-2024-05-13" }),
        modelsDevEntry({ id: "kimi-k2-0711-preview" }),
      ];

      const ids = (await fetchModelsDevModels("anthropic")).map((model) => model.id);

      expect(ids.sort()).toEqual(["claude-haiku-4-5", "gpt-4o", "kimi-k2-0711-preview"]);
    });

    it("sorts by release date, newest first, with undated entries last", async () => {
      modelsDevProviderModels = [
        modelsDevEntry({ id: "undated-model" }),
        modelsDevEntry({ id: "older-model", releaseDate: "2025-01-01" }),
        modelsDevEntry({ id: "newer-model", releaseDate: "2026-06-01" }),
      ];

      const ids = (await fetchModelsDevModels("google")).map((model) => model.id);

      expect(ids).toEqual(["newer-model", "older-model", "undated-model"]);
    });

    it("propagates catalog unavailability as an error (no fallback by design)", async () => {
      modelsDevProviderError = new Error("Could not load the model catalog from models.dev");

      await expect(fetchModelsDevModels("anthropic")).rejects.toThrow(
        "Could not load the model catalog from models.dev",
      );
    });
  });
});

describe("fetchLlamaCppServerModel", () => {
  it("returns the served model id and the server's context window", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: "qwen2.5-coder-7b" }] }),
        });
      if (url.endsWith("/props"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ default_generation_settings: { n_ctx: 16384 } }),
        });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({
      modelId: "qwen2.5-coder-7b",
      contextWindow: 16384,
    });
  });

  it("returns only the model id when /props is unreachable", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: "tinyllama" }] }),
        });
      if (url.endsWith("/props")) return Promise.resolve({ ok: false, status: 404 });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({
      modelId: "tinyllama",
    });
  });

  it("falls back to max_model_len from /v1/models when /props is unavailable", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: "model", max_model_len: 65536 }] }),
        });
      if (url.endsWith("/props")) return Promise.resolve({ ok: false, status: 404 });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8090/v1")).toEqual({
      modelId: "model",
      contextWindow: 65536,
    });
  });

  it("uses /props n_ctx instead of a model-card length", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: "some-model", max_model_len: 131072 }],
            }),
        });
      if (url.endsWith("/props"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ default_generation_settings: { n_ctx: 16384 } }),
        });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({
      modelId: "some-model",
      contextWindow: 16384,
    });
  });

  it("returns empty when llama.cpp requires auth and no API key is provided", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models")) return Promise.resolve({ ok: false, status: 401 });
      if (url.endsWith("/props")) return Promise.resolve({ ok: false, status: 401 });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8090/v1")).toEqual({});
  });

  it("passes API key as Bearer token to authenticated llama.cpp", async () => {
    global.fetch = mock((url: string, init?: RequestInit) => {
      const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
      if (authHeader !== "Bearer test-key") return Promise.resolve({ ok: false, status: 401 });
      if (url.endsWith("/v1/models"))
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: "qwen3.8-27b" }],
            }),
        });
      if (url.endsWith("/props"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ default_generation_settings: { n_ctx: 65536 } }),
        });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8090/v1", "test-key")).toEqual({
      modelId: "qwen3.8-27b",
      contextWindow: 65536,
    });
  });

  it("returns only the context window when /v1/models is unreachable", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models")) return Promise.resolve({ ok: false, status: 503 });
      if (url.endsWith("/props"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ default_generation_settings: { n_ctx: 8192 } }),
        });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({
      contextWindow: 8192,
    });
  });

  it("returns an empty object when the server is unreachable", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("connection refused")),
    ) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({});
  });

  it("ignores an empty model list", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      if (url.endsWith("/props"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ default_generation_settings: { n_ctx: 4096 } }),
        });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    expect(await fetchLlamaCppServerModel("http://localhost:8080/v1")).toEqual({
      contextWindow: 4096,
    });
  });
});

describe("local server probes against a server that never answers", () => {
  it("give every probe request a signal, so none can wait on Bun's fetch timeout", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    global.fetch = mock((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    await fetchLlamaCppServerModel("http://localhost:8080/v1");
    await fetchVllmServerModel("http://localhost:8000/v1", "model");
    await fetchSglangServerModel("http://localhost:30000/v1", "model");
    await fetchOllamaModelDetails("http://localhost:11434/api", "model");

    expect(signals.length).toBe(6);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("stop waiting as soon as the caller's signal aborts", async () => {
    global.fetch = actualFetch;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const startedAt = Date.now();
      const result = await fetchOllamaModelDetails(
        `http://127.0.0.1:${server.port}/api`,
        "model",
        AbortSignal.timeout(100),
      );

      expect(result).toEqual({});
      expect(Date.now() - startedAt).toBeLessThan(LOCAL_SERVER_PROBE_TIMEOUT_MS);
    } finally {
      server.stop(true);
    }
  });
});

describe("fetchOllamaRunningContextWindow", () => {
  function serveRunningModels(models: unknown[]): void {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/ps")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ models }) });
      }
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;
  }

  it("reads the window the server runs the model at, matching an untagged name to :latest", async () => {
    serveRunningModels([
      { name: "phi4:latest", context_length: 8192 },
      { name: "saluki-27b:latest", model: "saluki-27b:latest", context_length: 32768 },
    ]);
    expect(await fetchOllamaRunningContextWindow("http://h:11434/api", "saluki-27b")).toBe(32768);
  });

  it("is undefined while the model is not loaded", async () => {
    serveRunningModels([{ name: "phi4:latest", context_length: 8192 }]);
    expect(
      await fetchOllamaRunningContextWindow("http://h:11434/api", "saluki-27b"),
    ).toBeUndefined();
  });

  it("is undefined when the server does not answer", async () => {
    global.fetch = mock(() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(
      await fetchOllamaRunningContextWindow("http://h:11434/api", "saluki-27b"),
    ).toBeUndefined();
  });

  it("is carried on the model details beside the trained maximum", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/ps")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: "m:latest", context_length: 32768 }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ model_info: { "qwen35.context_length": 262144 } }),
      });
    }) as unknown as typeof fetch;
    expect(await fetchOllamaModelDetails("http://h:11434/api", "m")).toEqual({
      contextWindow: 262144,
      runningContextWindow: 32768,
    });
  });
});

describe("Ollama probes at run start", () => {
  it("keeps a replacement probe cached when an older expired probe fails", async () => {
    const originalFetch = globalThis.fetch;
    const now = spyOn(Date, "now").mockReturnValue(0);
    const pending: ((response: Response) => void)[] = [];
    globalThis.fetch = mock(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    ) as unknown as typeof fetch;
    const show = () => fetchOllamaModelDetails("http://ollama.test/api", "gemma4", undefined, []);
    try {
      const old = show();
      now.mockReturnValue(10_001);
      const replacement = show();
      pending[0]?.(new Response(null, { status: 503 }));
      expect(await old).toEqual({});
      const follower = show();
      for (const resolve of pending.slice(1)) resolve(Response.json({ capabilities: ["tools"] }));
      expect(await replacement).toEqual({ capabilities: ["tools"] });
      expect(await follower).toEqual({ capabilities: ["tools"] });
      expect(pending).toHaveLength(2);
    } finally {
      for (const resolve of pending) resolve(new Response(null, { status: 503 }));
      now.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["leader", "follower"] as const)(
    "cancels only the %s's wait while sharing both Ollama probes",
    async (cancelledCaller) => {
      const originalFetch = globalThis.fetch;
      const pending: { readonly url: string; readonly resolve: (response: Response) => void }[] =
        [];
      const networkSignals: AbortSignal[] = [];
      globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (signal) networkSignals.push(signal);
        return new Promise<Response>((resolve, reject) => {
          pending.push({ url: String(input), resolve });
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }) as unknown as typeof fetch;
      const leader = new AbortController();
      const follower = new AbortController();
      try {
        const first = fetchOllamaModelDetails("http://ollama.test/api", "gemma4", leader.signal);
        const second = fetchOllamaModelDetails("http://ollama.test/api", "gemma4", follower.signal);
        const cancelled = cancelledCaller === "leader" ? first : second;
        const surviving = cancelledCaller === "leader" ? second : first;
        (cancelledCaller === "leader" ? leader : follower).abort();
        const cancellation = await Promise.race([
          cancelled.then((result) => ({ kind: "answered" as const, result })),
          Bun.sleep(0).then(() => ({ kind: "waiting" as const })),
        ]);
        expect(cancellation).toEqual({ kind: "answered", result: {} });
        expect(networkSignals.every((signal) => !signal.aborted)).toBe(true);
        for (const request of pending) {
          request.resolve(
            request.url.endsWith("/ps")
              ? Response.json({ models: [{ name: "gemma4:latest", context_length: 8192 }] })
              : Response.json({ capabilities: ["completion", "tools"] }),
          );
        }
        const expected = { capabilities: ["completion", "tools"], runningContextWindow: 8192 };
        expect(await surviving).toEqual(expected);
        expect(await fetchOllamaModelDetails("http://ollama.test/api", "gemma4")).toEqual(expected);
        expect(pending).toHaveLength(2);
      } finally {
        for (const request of pending) request.resolve(new Response(null, { status: 503 }));
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("does not start a probe for an already-aborted caller", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(() => Promise.resolve(Response.json({ capabilities: ["tools"] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      expect(
        await fetchOllamaModelDetails("http://ollama.test/api", "gemma4", AbortSignal.abort()),
      ).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["success", "failure", "abort"] as const)(
    "removes caller abort listeners after probe %s",
    async (outcome) => {
      const originalFetch = globalThis.fetch;
      const controller = new AbortController();
      const added = spyOn(controller.signal, "addEventListener");
      const removed = spyOn(controller.signal, "removeEventListener");
      const pending: ((response: Response) => void)[] = [];
      globalThis.fetch = mock(() => {
        if (outcome === "failure") return Promise.reject(new Error("connection refused"));
        if (outcome === "success") return Promise.resolve(Response.json({}));
        return new Promise<Response>((resolve) => pending.push(resolve));
      }) as unknown as typeof fetch;
      try {
        const result = fetchOllamaModelDetails(
          "http://ollama.test/api",
          "gemma4",
          controller.signal,
        );
        if (outcome === "abort") controller.abort();
        expect(await result).toEqual({});
        const listeners = added.mock.calls
          .filter(([type]) => type === "abort")
          .map(([, listener]) => listener);
        expect(listeners.length).toBeGreaterThan(0);
        for (const listener of listeners) {
          expect(
            removed.mock.calls.some(
              ([type, removedListener]) => type === "abort" && removedListener === listener,
            ),
          ).toBe(true);
        }
      } finally {
        for (const resolve of pending) resolve(Response.json({}));
        added.mockRestore();
        removed.mockRestore();
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("share one /api/show and one /api/ps between callers asking about the same model", async () => {
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = String(input);
      requested.push(url.slice(url.lastIndexOf("/")));
      return Promise.resolve(
        url.endsWith("/ps")
          ? Response.json({ models: [] })
          : Response.json({ capabilities: ["completion", "tools"] }),
      );
    }) as unknown as typeof fetch;
    try {
      const [first, second] = await Promise.all([
        fetchOllamaModelDetails("http://ollama.test/api", "gemma4"),
        fetchOllamaModelDetails("http://ollama.test/api", "gemma4"),
      ]);
      await fetchOllamaRunningContextWindow("http://ollama.test/api", "gemma4");

      expect(first.capabilities).toEqual(["completion", "tools"]);
      expect(second).toEqual(first);
      expect(requested.sort()).toEqual(["/ps", "/show"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("asks again after a failed probe instead of keeping the failure", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve(Response.json({ capabilities: ["completion"] }));
    }) as unknown as typeof fetch;
    try {
      const shown = (url: string) =>
        fetchOllamaModelDetails(url, "gemma4", undefined, []).then(
          (details) => details.capabilities,
        );
      expect(await shown("http://ollama.test/api")).toBeUndefined();
      expect(await shown("http://ollama.test/api")).toEqual(["completion"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
