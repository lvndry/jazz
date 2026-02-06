import { tavily } from "@tavily/core";
import { Effect } from "effect";
import Exa from "exa-js";
import Parallel from "parallel-web";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionResult } from "@/core/types";
import type { WebSearchConfig } from "@/core/types/config";
import { defineTool } from "./base-tool";

export interface WebSearchArgs extends Record<string, unknown> {
  readonly query: string;
  readonly depth?: "standard" | "deep";
  readonly maxResults?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
}

export interface WebSearchItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
  readonly source?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface WebSearchResult {
  readonly results: readonly WebSearchItem[];
  readonly totalResults: number;
  readonly query: string;
  readonly timestamp: string;
  readonly provider: "exa" | "parallel" | "tavily" | "brave" | "perplexity";
}

/**
 * Available web search providers with their display names
 * Used by CLI and other parts of the system to list available providers
 */
export const WEB_SEARCH_PROVIDERS = [
  { name: "Parallel", value: "parallel" },
  { name: "Exa", value: "exa" },
  { name: "Tavily", value: "tavily" },
  { name: "Brave", value: "brave" },
  { name: "Perplexity", value: "perplexity" },
] as const;

export const DEFAULT_MAX_RESULTS = 50;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDERS)[number]["value"];

export function createWebSearchTool(): ReturnType<
  typeof defineTool<AgentConfigService | LoggerService, WebSearchArgs>
> {
  return defineTool<AgentConfigService | LoggerService, WebSearchArgs>({
    name: "web_search",
    description:
      "Search the web for current, real-time information using Parallel, Exa, Tavily, Brave, or Perplexity search engine. Returns high-quality search results with snippets and sources that you can use to synthesize answers. Supports different search depths (standard/deep). Use to find current events, recent information, or facts that may have changed since training data.",
    tags: ["web", "search"],
    parameters: z
      .object({
        query: z
          .string()
          .min(1, "query cannot be empty")
          .max(5000, "query cannot be longer than 5000 characters")
          .describe(
            "The search query to execute. You should refine and improve the user's original query to be as specific as possible. Add context or constraints to narrow down results. Examples: 1. Bad: 'Total' -> Good: 'French energy company Total website'. 2. Bad: 'Python error' -> Good: 'Python TypeError: int object is not iterable solution'. 3. Bad: 'best restaurants' -> Good: 'best Italian restaurants in downtown Chicago 2024'.",
          ),
        depth: z
          .enum(["standard", "deep"])
          .optional()
          .describe(
            "Search depth - 'standard' for quick results, 'deep' for comprehensive search (default: 'standard')",
          ),
        fromDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be in ISO 8601 format (YYYY-MM-DD)")
          .optional()
          .describe(
            "The date from which the search results should be considered, in ISO 8601 format (YYYY-MM-DD)",
          ),
        toDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be in ISO 8601 format (YYYY-MM-DD)")
          .optional()
          .describe(
            "The date until which the search results should be considered, in ISO 8601 format (YYYY-MM-DD)",
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Maximum number of results to return (default: ${DEFAULT_MAX_RESULTS}, max: 100)`),
      })
      .strict(),
    validate: (args) => {
      const params = (
        z
          .object({
            query: z.string().min(1),
            depth: z.enum(["standard", "deep"]).optional(),
            fromDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be in ISO 8601 format (YYYY-MM-DD)")
              .optional(),
            toDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be in ISO 8601 format (YYYY-MM-DD)")
              .optional(),
            maxResults: z.number().int().min(1).max(100).optional(),
          })
          .strict() as z.ZodType<WebSearchArgs>
      ).safeParse(args);

      if (!params.success) {
        return { valid: false, errors: params.error.issues.map((i) => i.message) };
      }
      return { valid: true, value: params.data };
    },
    handler: function webSearchHandler(
      args: WebSearchArgs,
    ): Effect.Effect<ToolExecutionResult, Error, AgentConfigService | LoggerService> {
      return Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        const logger = yield* LoggerServiceTag;

        // Get web search config
        const appConfig = yield* config.appConfig;
        const webSearchConfig: WebSearchConfig | undefined = appConfig.web_search;
        const selectedProvider = webSearchConfig?.provider;

        // If no external provider is configured, the AI SDK service will handle
        // using the provider-native web search (if available). This tool handler
        // should only execute when an external provider (Parallel, Exa, Tavily) is selected.
        if (!selectedProvider) {
          return {
            success: false,
            result: null,
            error:
              "No external web search provider configured. If your LLM provider supports built-in web search, it will be used automatically. Otherwise, please configure an external provider (Parallel, Exa, Tavily, Brave, or Perplexity) in settings.",
          };
        }

        const getApiKey = (
          providerName: string,
        ): Effect.Effect<string, never, AgentConfigService> =>
          Effect.gen(function* () {
            return yield* config.getOrElse(`web_search.${providerName}.api_key`, "");
          });

        // Get API key for the selected provider
        const apiKey = yield* getApiKey(selectedProvider);

        if (!apiKey) {
          return {
            success: false,
            result: null,
            error: `No API key configured for ${selectedProvider}. Please configure 'web_search.${selectedProvider}.api_key' in settings.`,
          };
        }

        // Map provider name to execution function
        const executorMap: Record<
          "exa" | "parallel" | "tavily" | "brave" | "perplexity",
          (args: WebSearchArgs, apiKey: string) => Effect.Effect<WebSearchResult, Error, LoggerService>
        > = {
          exa: executeExaSearch,
          parallel: executeParallelSearch,
          tavily: executeTavilySearch,
          brave: executeBraveSearch,
          perplexity: executePerplexitySearch,
        };

        const executor = executorMap[selectedProvider];

        yield* logger.info(`Executing search with ${selectedProvider} provider...`);

        const result = yield* executor(args, apiKey).pipe(
          Effect.catchAll((error) => {
            return Effect.gen(function* () {
              yield* logger.error(
                `${selectedProvider} search failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              return null as WebSearchResult | null;
            });
          }),
        );

        if (result) {
          return {
            success: true,
            result,
          };
        }

        return {
          success: false,
          result: null,
          error: `Search with ${selectedProvider} provider failed. Please check your configuration or try a different provider.`,
        };
      });
    },
    createSummary: function createSearchSummary(result: ToolExecutionResult): string | undefined {
      if (!result.success || !result.result) return undefined;

      const searchResult = result.result as WebSearchResult;
      return `Found ${searchResult.totalResults} results for "${searchResult.query}" using ${searchResult.provider}`;
    },
  });
}

let cachedExaClient: Exa | null = null;
let cachedParallelClient: Parallel | null = null;
let cachedTavilyClient: ReturnType<typeof tavily> | null = null;

/**
 * Execute an Exa search
 */
function executeExaSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (!cachedExaClient) {
      cachedExaClient = new Exa(apiKey);
    }

    const exa = cachedExaClient;

    yield* logger.info(
      `Executing Exa search for query: "${args.query}" with depth: ${args.depth || "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        const searchOptions: Parameters<typeof exa.search>[1] = {
          type: "auto",
          useAutoprompt: true,
          numResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
        };

        if (args.fromDate) {
          searchOptions.startPublishedDate = args.fromDate;
        }
        if (args.toDate) {
          searchOptions.endPublishedDate = args.toDate;
        }

        return await exa.search(args.query, searchOptions);
      },
      catch: (error) =>
        new Error(`Exa search failed: ${error instanceof Error ? error.message : String(error)}`),
    });

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.text || "",
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      source: "exa",
    }));

    yield* logger.info(`Exa search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "exa" as const,
    };
  });
}

/**
 * Execute a Parallel search
 */
function executeParallelSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (!cachedParallelClient) {
      cachedParallelClient = new Parallel({ apiKey });
    }

    const parallel = cachedParallelClient;

    yield* logger.info(
      `Executing Parallel search for query: "${args.query}" with depth: ${args.depth ?? "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        return await parallel.beta.search({
          objective: args.query,
          mode: "agentic",
          max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
        });
      },
      catch: (error) =>
        new Error(
          `Parallel search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.excerpts?.join(" ") || "",
      ...(result.publish_date ? { publishedDate: result.publish_date } : {}),
      source: "parallel",
    }));

    yield* logger.info(`Parallel search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "parallel" as const,
    };
  });
}

/**
 * Execute a Tavily search
 */
function executeTavilySearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (!cachedTavilyClient) {
      cachedTavilyClient = tavily({ apiKey });
    }

    const client = cachedTavilyClient;

    yield* logger.info(
      `Executing Tavily search for query: "${args.query}" with depth: ${args.depth ?? "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        const searchOptions = {
          searchDepth: args.depth === "deep" ? ("advanced" as const) : ("basic" as const),
          maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
          ...(args.fromDate && { startDate: args.fromDate }),
          ...(args.toDate && { endDate: args.toDate }),
        };

        return await client.search(args.query, searchOptions);
      },
      catch: (error) =>
        new Error(
          `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.content || "",
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      source: "tavily",
      ...(result.score !== undefined ? { metadata: { score: result.score } } : {}),
    }));

    yield* logger.info(`Tavily search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "tavily" as const,
    };
  });
}

/**
 * Execute a Brave search
 */
function executeBraveSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.info(
      `Executing Brave search for query: "${args.query}" with depth: ${args.depth ?? "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.append("q", args.query);
        url.searchParams.append("count", (args.maxResults ?? DEFAULT_MAX_RESULTS).toString());

        const res = await fetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });

        if (!res.ok) {
          throw new Error(`Brave search failed: ${res.statusText}`);
        }

        return (await res.json()) as {
          web?: {
            results?: Array<{
              title: string;
              url: string;
              description: string;
            }>;
          };
        };
      },
      catch: (error) =>
        new Error(`Brave search failed: ${error instanceof Error ? error.message : String(error)}`),
    });

    const results: WebSearchItem[] = (response.web?.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.description || "",
      source: "brave",
    }));

    yield* logger.info(`Brave search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "brave" as const,
    };
  });
}

/**
 * Execute a Perplexity search
 */
function executePerplexitySearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.info(
      `Executing Perplexity search for query: "${args.query}" with depth: ${args.depth ?? "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch("https://api.perplexity.ai/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: args.query,
            max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
          }),
        });

        if (!res.ok) {
          throw new Error(`Perplexity search failed: ${res.statusText}`);
        }

        return (await res.json()) as {
          results?: Array<{
            title: string;
            url: string;
            snippet: string;
          }>;
        };
      },
      catch: (error) =>
        new Error(
          `Perplexity search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.snippet || "",
      source: "perplexity",
    }));

    yield* logger.info(`Perplexity search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "perplexity" as const,
    };
  });
}
