import { Effect } from "effect";
import {
  LinkupClient,
  type SearchDepth,
  type SearchOutputType,
  type SearchResults,
  type SourcedAnswer,
} from "linkup-sdk";
import { z } from "zod";
import { AgentConfigService, type ConfigService } from "../../../services/config";
import { defineTool } from "./base-tool";
import { type ToolExecutionContext, type ToolExecutionResult } from "./tool-registry";

/**
 * Unified web search tool that provides fallback from Linkup to web search options
 * This tool maintains a consistent interface while switching between search providers
 */

export interface WebSearchArgs extends Record<string, unknown> {
  readonly query: string;
  readonly depth?: SearchDepth;
  readonly outputType?: SearchOutputType;
  readonly includeImages?: boolean;
}

export interface WebSearchResult {
  readonly answer?: string;
  readonly results: readonly WebSearchItem[];
  readonly totalResults: number;
  readonly query: string;
  readonly timestamp: string;
  readonly provider: "linkup" | "web_search";
}

export interface WebSearchItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
  readonly source?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface LinkupConfig {
  readonly apiKey: string;
}

/**
 * Create a unified web search tool that tries Linkup first, then falls back to web search options
 *
 * @returns A tool that can search the web using Linkup or web search fallback
 */
export function createWebSearchTool(): ReturnType<typeof defineTool<ConfigService, WebSearchArgs>> {
  return defineTool<ConfigService, WebSearchArgs>({
    name: "web_search",
    description:
      "Search the web for current information. Uses Linkup search engine by default. Provides high-quality, factual search results to enrich AI responses with current information from the internet.",
    tags: ["web", "search"],
    parameters: z
      .object({
        query: z
          .string()
          .min(1, "query cannot be empty")
          .describe("The search query to execute. Be specific and detailed for better results."),
        depth: z
          .enum(["standard", "deep"])
          .optional()
          .describe(
            "Search depth - 'standard' for quick results, 'deep' for comprehensive search (default: 'standard')",
          ),
        outputType: z
          .enum(["sourcedAnswer", "searchResults", "structured"])
          .optional()
          .describe(
            "Output format - 'sourcedAnswer' for AI-friendly format, 'searchResults' for raw results, 'structured' for structured data (default: 'sourcedAnswer')",
          ),
        includeImages: z
          .boolean()
          .optional()
          .describe("Whether to include images in search results (default: false)"),
      })
      .strict(),
    validate: (args) => {
      const result = (
        z
          .object({
            query: z.string().min(1),
            depth: z.enum(["standard", "deep"]).optional(),
            outputType: z.enum(["sourcedAnswer", "searchResults", "structured"]).optional(),
            includeImages: z.boolean().optional(),
          })
          .strict() as z.ZodType<WebSearchArgs>
      ).safeParse(args);
      if (!result.success) {
        return { valid: false, errors: result.error.issues.map((i) => i.message) } as const;
      }
      return { valid: true, value: result.data } as const;
    },
    handler: function webSearchHandler(
      args: WebSearchArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult, Error, ConfigService> {
      return Effect.gen(function* () {
        const config = yield* AgentConfigService;

        // Try Linkup first
        const linkupResult = yield* tryLinkupSearch(args, config).pipe(
          Effect.catchAll((error) => {
            // Log the error but don't fail - we'll fall back to web search
            console.warn(`Linkup search failed, falling back to web search: ${error.message}`);
            return Effect.succeed(null);
          }),
        );

        if (linkupResult) {
          return {
            success: true,
            result: linkupResult,
          };
        }

        // Fallback to web search options
        const webSearchResult = yield* performWebSearchFallback(args, context);

        return {
          success: true,
          result: webSearchResult,
        };
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error.message,
          }),
        ),
      );
    },
    createSummary: function createSearchSummary(result: ToolExecutionResult): string | undefined {
      if (!result.success || !result.result) return undefined;

      const searchResult = result.result as WebSearchResult;
      return `Found ${searchResult.totalResults} results for "${searchResult.query}" using ${searchResult.provider}`;
    },
  });
}

/**
 * Try to perform a Linkup search
 */
function tryLinkupSearch(
  args: WebSearchArgs,
  config: ConfigService,
): Effect.Effect<WebSearchResult, Error> {
  return Effect.gen(function* () {
    // Get Linkup configuration
    const linkupConfig = yield* getLinkupConfig(config);

    // Create Linkup client
    const client = new LinkupClient({
      apiKey: linkupConfig.apiKey,
    });

    // Prepare search parameters
    const searchParams = {
      query: args.query,
      depth: args.depth ?? "standard",
      outputType: args.outputType ?? "sourcedAnswer",
      includeImages: args.includeImages ?? false,
    };

    const searchResult = yield* performLinkupSearch(client, searchParams);

    return {
      ...(searchResult.answer && { answer: searchResult.answer }),
      results: searchResult.results,
      totalResults: searchResult.totalResults,
      query: searchResult.query,
      timestamp: searchResult.timestamp,
      provider: "linkup" as const,
    };
  });
}

/**
 * Perform web search fallback using web_search_options
 * This function returns a placeholder result since the actual web search
 * is handled by the LLM service with web_search_options
 */
function performWebSearchFallback(
  args: WebSearchArgs,
  _context: ToolExecutionContext,
): Effect.Effect<WebSearchResult, Error> {
  // Return a placeholder result indicating web search fallback
  // The actual web search is handled by the LLM service with web_search_options
  const fallbackResult: WebSearchResult = {
    results: [
      {
        title: "Web Search Fallback",
        url: "https://example.com",
        snippet: `Web search fallback activated for query: "${args.query}". This indicates that Linkup search was unavailable and the system fell back to web search options.`,
        source: "web_search_fallback",
      },
    ],
    totalResults: 1,
    query: args.query,
    timestamp: new Date().toISOString(),
    provider: "web_search" as const,
  };

  return Effect.succeed(fallbackResult);
}

/**
 * Get Linkup configuration from the config service
 */
function getLinkupConfig(config: ConfigService): Effect.Effect<LinkupConfig, Error> {
  return Effect.gen(function* () {
    const apiKey = yield* config
      .getOrFail("linkup.apiKey")
      .pipe(
        Effect.catchAll(() =>
          Effect.fail(
            new Error(
              "Linkup API key is required. Please set linkup.apiKey in your configuration.",
            ),
          ),
        ),
      );

    if (!apiKey || typeof apiKey !== "string") {
      return yield* Effect.fail(
        new Error("Linkup API key is required. Please set linkup.apiKey in your configuration."),
      );
    }

    return {
      apiKey: apiKey,
    };
  });
}

function performLinkupSearch(
  client: LinkupClient,
  params: {
    query: string;
    depth: SearchDepth;
    outputType: SearchOutputType;
    includeImages: boolean;
  },
): Effect.Effect<
  {
    answer?: string;
    results: readonly WebSearchItem[];
    totalResults: number;
    query: string;
    timestamp: string;
  },
  Error
> {
  return Effect.tryPromise({
    try: async () => {
      const response = await client.search({
        query: params.query,
        depth: params.depth,
        outputType: params.outputType,
        includeImages: params.includeImages,
      });

      let searchResult: {
        answer?: string;
        results: readonly WebSearchItem[];
        totalResults: number;
        query: string;
        timestamp: string;
      };

      if (params.outputType === "sourcedAnswer") {
        const sourcedAnswer = response as SourcedAnswer;
        searchResult = {
          answer: sourcedAnswer.answer,
          results: sourcedAnswer.sources.map((source) => {
            if ("snippet" in source) {
              return {
                title: source.name || "",
                url: source.url || "",
                snippet: source.snippet || "",
                source: source.name,
              };
            } else {
              return {
                title: source.name || "",
                url: source.url || "",
                snippet: source.type === "text" ? source.content : "",
                source: source.name,
              };
            }
          }),
          totalResults: sourcedAnswer.sources.length,
          query: params.query,
          timestamp: new Date().toISOString(),
        };
      } else if (params.outputType === "searchResults") {
        const searchResults = response as SearchResults;

        searchResult = {
          results: searchResults.results.map((result) => ({
            title: result.name || "",
            url: result.url || "",
            snippet: result.type === "text" ? result.content : "",
            source: result.name,
          })),
          totalResults: searchResults.results.length,
          query: params.query,
          timestamp: new Date().toISOString(),
        };
      } else {
        return {
          results: [],
          totalResults: 0,
          query: params.query,
          timestamp: new Date().toISOString(),
        };
      }

      return searchResult;
    },
    catch: (error) =>
      new Error(`Linkup search failed: ${error instanceof Error ? error.message : String(error)}`),
  });
}
