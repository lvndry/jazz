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
      data: [
        { id: "m1", name: "Model 1", context_length: 8192, supported_parameters: ["tools"] }
      ]
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    })) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/models", "key");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("m1");
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("should handle Ollama with special transformation", async () => {
    const mockTagsResponse = {
      models: [{ name: "llama3:latest", details: { metadata: { supports_tools: true } } }]
    };
    const mockShowResponse = {
      model_info: { "llama.context_length": 4096 }
    };


    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/tags")) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTagsResponse) });
      if (url.endsWith("/api/show")) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockShowResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("ollama", "http://localhost:11434", "/api/tags");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("llama3:latest");
    expect(result[0]!.contextWindow).toBe(4096);
  });

  it("should fail gracefully on 404", async () => {
    global.fetch = mock(() => Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found"
    })) as unknown as typeof fetch;

    const program = fetcher.fetchModels("openrouter", "https://or.api", "/bad");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
  });
});
