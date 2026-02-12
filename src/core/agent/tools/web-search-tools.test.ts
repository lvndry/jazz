import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { Effect, Layer } from "effect";
import { createWebSearchTool, DEFAULT_MAX_RESULTS, type WebSearchArgs } from "./web-search-tools";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { LoggerServiceTag } from "../../interfaces/logger";
import type { AppConfig } from "../../types";

// Mock exa-js
const mockExaSearch = mock();
mock.module("exa-js", () => {
  return {
    default: class {
      search = mockExaSearch;
    },
  };
});

describe("WebSearchTool", () => {
  afterAll(() => {
    mock.restore();
  });

  const mockAppConfig: AppConfig = {
    storage: { type: "file", path: "./.jazz" },
    logging: { level: "info", format: "plain" },
    web_search: {
      provider: "exa",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockServices = (config: AppConfig, apiKeys: Record<string, string> = {}) => {
    const mockConfigService = {
      get: vi.fn().mockReturnValue(Effect.fail(new Error("Config not found"))),
      getOrElse: vi.fn().mockImplementation((key: string) => {
        const provider = key.split(".")[1];
        if (apiKeys[provider]) return Effect.succeed(apiKeys[provider]);
        return Effect.succeed("");
      }),
      getOrFail: vi.fn().mockReturnValue(Effect.fail(new Error("API key not found"))),
      has: vi.fn().mockReturnValue(Effect.succeed(false)),
      set: vi.fn().mockReturnValue(Effect.succeed(undefined)),
      appConfig: Effect.succeed(config),
    };

    const mockLoggerService = {
      debug: vi.fn().mockReturnValue(Effect.void),
      info: vi.fn().mockReturnValue(Effect.void),
      warn: vi.fn().mockReturnValue(Effect.void),
      error: vi.fn().mockReturnValue(Effect.void),
      writeToFile: vi.fn().mockReturnValue(Effect.void),
      logToolCall: vi.fn().mockReturnValue(Effect.void),
      setSessionId: vi.fn().mockReturnValue(Effect.void),
      clearSessionId: vi.fn().mockReturnValue(Effect.void),
    };

    return Layer.merge(
      Layer.succeed(AgentConfigServiceTag, mockConfigService as any),
      Layer.succeed(LoggerServiceTag, mockLoggerService as any),
    );
  };

  it("should create a web search tool with correct structure", () => {
    const tool = createWebSearchTool();

    expect(tool.name).toBe("web_search");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.hidden).toBe(false);
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should have correct parameter schema", () => {
    const tool = createWebSearchTool();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters).toHaveProperty("_def");

    const schema = tool.parameters as unknown as { _def: { shape: Record<string, unknown> } };
    expect(schema._def.shape).toHaveProperty("query");
    expect(schema._def.shape).toHaveProperty("depth");
    expect(schema._def.shape).toHaveProperty("fromDate");
    expect(schema._def.shape).toHaveProperty("toDate");
    expect(schema._def.shape).toHaveProperty("maxResults");
  });

  describe("Provider Execution", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn() as any;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    const providers = [
      {
        name: "exa",
        apiKey: "exa-key",
        setupMock: () => {
          mockExaSearch.mockResolvedValue({
            results: [{ title: "Exa Result", url: "https://exa.ai", text: "Exa snippet" }],
          });
        },
        verifyMock: (args: WebSearchArgs) => {
          expect(mockExaSearch).toHaveBeenCalledWith(
            args.query,
            expect.objectContaining({ numResults: args.maxResults ?? DEFAULT_MAX_RESULTS }),
          );
        },
      },
      {
        name: "brave",
        apiKey: "brave-key",
        setupMock: () => {
          (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
              web: {
                results: [
                  { title: "Brave Result", url: "https://brave.com", description: "Brave snippet" },
                ],
              },
            }),
          });
        },
        verifyMock: (args: WebSearchArgs) => {
          const lastCall = (global.fetch as any).mock.calls[0][0];
          const url = new URL(lastCall);
          expect(url.searchParams.get("count")).toBe(
            (args.maxResults ?? DEFAULT_MAX_RESULTS).toString(),
          );
        },
      },
      {
        name: "perplexity",
        apiKey: "pplx-key",
        setupMock: () => {
          (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [
                {
                  title: "Perplexity Result",
                  url: "https://perplexity.ai",
                  snippet: "Pplx snippet",
                },
              ],
            }),
          });
        },
        verifyMock: (args: WebSearchArgs) => {
          const lastCallBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
          expect(lastCallBody.max_results).toBe(args.maxResults ?? DEFAULT_MAX_RESULTS);
        },
      },
    ];

    describe.each(providers)("Provider: $name", (provider) => {
      it(`should use the configured provider (${provider.name})`, async () => {
        const tool = createWebSearchTool();
        const config = { ...mockAppConfig, web_search: { provider: provider.name as any } };
        const layer = createMockServices(config, { [provider.name]: provider.apiKey });

        provider.setupMock();

        const result = await Effect.runPromise(
          tool.execute({ query: "test" }, { agentId: "test" }).pipe(Effect.provide(layer)),
        );

        expect((result as any).success).toBe(true);
        expect((result as any).result.provider).toBe(provider.name);
        expect((result as any).result.results[0].title).toContain(
          provider.name.charAt(0).toUpperCase() + provider.name.slice(1),
        );
      });

      it(`should pass maxResults to ${provider.name}`, async () => {
        const tool = createWebSearchTool();
        const config = { ...mockAppConfig, web_search: { provider: provider.name as any } };
        const layer = createMockServices(config, { [provider.name]: provider.apiKey });

        provider.setupMock();

        const args = { query: "test", maxResults: 10 };
        await Effect.runPromise(
          tool.execute(args, { agentId: "test" }).pipe(Effect.provide(layer)),
        );

        provider.verifyMock(args);
      });

      it(`should use default maxResults if not provided to ${provider.name}`, async () => {
        const tool = createWebSearchTool();
        const config = { ...mockAppConfig, web_search: { provider: provider.name as any } };
        const layer = createMockServices(config, { [provider.name]: provider.apiKey });

        provider.setupMock();

        const args = { query: "test" };
        await Effect.runPromise(
          tool.execute(args, { agentId: "test" }).pipe(Effect.provide(layer)),
        );

        provider.verifyMock(args);
      });
    });
  });

  describe("Summaries", () => {
    it("should create correct summary", () => {
      const tool = createWebSearchTool();
      const mockResult = {
        success: true,
        result: { totalResults: 5, query: "test search", provider: "exa" },
      };
      expect(tool.createSummary?.(mockResult)).toBe('Found 5 results for "test search" using exa');
    });

    it("should handle web search fallback summary", () => {
      const tool = createWebSearchTool();
      const mockResult = {
        success: true,
        result: { totalResults: 1, query: "fallback test", provider: "web_search" },
      };
      expect(tool.createSummary?.(mockResult)).toBe(
        'Found 1 results for "fallback test" using web_search',
      );
    });
  });
});
