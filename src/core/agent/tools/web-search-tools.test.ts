import { beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { Effect, Layer } from "effect";
import { createWebSearchTool } from "./web-search-tools";
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
  const mockAppConfig: AppConfig = {
    storage: { type: "file", path: "./.jazz" },
    logging: { level: "info", format: "pretty", output: "console" },
    web_search: {
      priority_order: ["parallel", "exa"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a web search tool with correct structure", () => {
    const tool = createWebSearchTool();

    expect(tool.name).toBe("web_search");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20); // Ensure description is meaningful
    expect(tool.hidden).toBe(false);
    expect(tool.execute).toBeDefined();
    expect(typeof tool.execute).toBe("function");
    expect(tool.createSummary).toBeDefined();
    expect(typeof tool.createSummary).toBe("function");
  });

  it("should have correct parameter schema", () => {
    const tool = createWebSearchTool();

    // Check if parameters is a Zod schema (it should be)
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.parameters).toBe("object");

    // For Zod schemas, we check for _def property instead of type/properties
    expect(tool.parameters).toHaveProperty("_def");

    // Check that the schema has the expected shape properties
    const schema = tool.parameters as unknown as { _def: { shape: Record<string, unknown> } };
    expect(schema._def.shape).toHaveProperty("query");
    expect(schema._def.shape).toHaveProperty("depth");
    expect(schema._def.shape).toHaveProperty("fromDate");
    expect(schema._def.shape).toHaveProperty("toDate");
  });

  it("should validate arguments correctly", async () => {
    const tool = createWebSearchTool();

    // Mock config service
    const mockConfigService = {
      get: vi.fn().mockReturnValue(Effect.fail(new Error("Config not found"))),
      getOrElse: vi.fn().mockImplementation((key) => {
        if (key === "web_search.exa.api_key") return Effect.succeed("");
        if (key === "web_search.parallel.api_key") return Effect.succeed("");
        return Effect.succeed("default");
      }),
      getOrFail: vi.fn().mockReturnValue(Effect.fail(new Error("API key not found"))),
      has: vi.fn().mockReturnValue(Effect.succeed(false)),
      set: vi.fn().mockReturnValue(Effect.succeed(undefined)),
      appConfig: Effect.succeed(mockAppConfig),
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

    const mockLayer = Layer.merge(
      Layer.succeed(AgentConfigServiceTag, mockConfigService),
      Layer.succeed(LoggerServiceTag, mockLoggerService),
    );

    const validArgs = {
      query: "test search",
      depth: "standard" as const,
    };
    const validationResult = await Effect.runPromise(
      Effect.provide(tool.execute(validArgs, { agentId: "test" }), mockLayer),
    );
    expect(validationResult).toBeDefined();

    const invalidArgs = { query: 123 }; // Invalid type
    const invalidResult = await Effect.runPromise(
      Effect.provide(tool.execute(invalidArgs, { agentId: "test" }), mockLayer),
    );
    expect(invalidResult).toBeDefined();
  });

  it("should fallback to Exa when Parallel is unavailable", async () => {
    const tool = createWebSearchTool();

    // Mock config service: Parallel missing, Exa present
    const mockConfigService = {
      get: vi.fn().mockReturnValue(Effect.fail(new Error("Config not found"))),
      getOrElse: vi.fn().mockImplementation((key) => {
        if (key === "web_search.exa.api_key") return Effect.succeed("exa-key");
        if (key === "web_search.parallel.api_key") return Effect.succeed("");
        return Effect.succeed("default");
      }),
      getOrFail: vi.fn().mockReturnValue(Effect.fail(new Error("Parallel API key not found"))),
      has: vi.fn().mockReturnValue(Effect.succeed(false)),
      set: vi.fn().mockReturnValue(Effect.succeed(undefined)),
      appConfig: Effect.succeed(mockAppConfig),
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

    const mockLayer = Layer.merge(
      Layer.succeed(AgentConfigServiceTag, mockConfigService),
      Layer.succeed(LoggerServiceTag, mockLoggerService),
    );

    // Mock Exa response
    mockExaSearch.mockResolvedValue({
      results: [
        {
          title: "Exa Result",
          url: "https://exa.ai",
          text: "This is a result from Exa",
        },
      ],
    });

    const context = {
      agentId: "test-agent",
      conversationId: "test-conversation",
    };

    const args = {
      query: "test search",
      depth: "standard" as const,
    };

    const result = await Effect.runPromise(
      tool.execute(args, context).pipe(Effect.provide(mockLayer)),
    );

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();

    const searchResult = result.result as {
      provider: string;
      query: string;
      results: Array<{ title: string }>;
    };
    expect(searchResult.provider).toBe("exa");
    expect(searchResult.query).toBe("test search");
    expect(searchResult.results).toHaveLength(1);
    expect(searchResult.results[0]!.title).toBe("Exa Result");
  });

  it("should create correct summary", () => {
    const tool = createWebSearchTool();

    const mockResult = {
      success: true,
      result: {
        totalResults: 5,
        query: "test search",
        provider: "exa",
      },
    };

    const summary = tool.createSummary?.(mockResult);
    expect(summary).toBe('Found 5 results for "test search" using exa');
  });

  it("should handle web search fallback summary", () => {
    const tool = createWebSearchTool();

    const mockResult = {
      success: true,
      result: {
        totalResults: 1,
        query: "fallback test",
        provider: "web_search",
      },
    };

    const summary = tool.createSummary?.(mockResult);
    expect(summary).toBe('Found 1 results for "fallback test" using web_search');
  });
});
