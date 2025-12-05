import { Effect } from "effect";
import Exa from "exa-js";
import { LinkupClient, type SearchDepth } from "linkup-sdk";
import Parallel from "parallel-web";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "../../interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import type { ToolExecutionResult } from "../../types";
import type { WebSearchConfig } from "../../types/config";
import { defineTool } from "./base-tool";

export interface WebSearchArgs extends Record<string, unknown> {
  readonly query: string;
  readonly depth?: SearchDepth;
  readonly includeImages?: boolean;
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
  readonly provider: "linkup" | "exa" | "parallel";
}

const MAX_RESULTS = 200;

export function createWebSearchTool(): ReturnType<
  typeof defineTool<AgentConfigService | LoggerService, WebSearchArgs>
> {
  return defineTool<AgentConfigService | LoggerService, WebSearchArgs>({
    name: "web_search",
    description:
      "Search the web for current, real-time information using Linkup or Exa search engine. Returns high-quality search results with snippets and sources that you can use to synthesize answers. Supports different search depths (standard/deep). Use to find current events, recent information, or facts that may have changed since training data.",
    tags: ["web", "search"],
    parameters: z
      .object({
        query: z
          .string()
          .min(1, "query cannot be empty")
          .describe(
            "The search query to execute. You should refine and improve the user's original query to be as specific as possible. Add context or constraints to narrow down results. Examples: 1. Bad: 'Total' -> Good: 'French energy company Total website'. 2. Bad: 'Python error' -> Good: 'Python TypeError: int object is not iterable solution'. 3. Bad: 'best restaurants' -> Good: 'best Italian restaurants in downtown Chicago 2024'.",
          ),
        depth: z
          .enum(["standard", "deep"])
          .optional()
          .describe(
            "Search depth - 'standard' for quick results, 'deep' for comprehensive search (default: 'standard')",
          ),
        includeImages: z
          .boolean()
          .optional()
          .describe("Whether to include images in search results (default: false)"),
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
      })
      .strict(),
    validate: (args) => {
      const params = (
        z
          .object({
            query: z.string().min(1),
            depth: z.enum(["standard", "deep"]).optional(),
            includeImages: z.boolean().optional(),
            fromDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be in ISO 8601 format (YYYY-MM-DD)")
              .optional(),
            toDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be in ISO 8601 format (YYYY-MM-DD)")
              .optional(),
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
        const priorityOrder: readonly string[] = webSearchConfig?.priority_order ?? [
          "parallel",
          "exa",
          "linkup",
        ];

        // Build provider registry with API keys
        const providers: Array<{
          name: string;
          apiKey: string;
          execute: (
            args: WebSearchArgs,
            apiKey: string,
          ) => Effect.Effect<WebSearchResult, Error, LoggerService>;
        }> = [];

        const getApiKey = (
          providerName: string,
        ): Effect.Effect<string, never, AgentConfigService> =>
          Effect.gen(function* () {
            return yield* config.getOrElse(`web_search.${providerName}.api_key`, "");
          });

        // Register available providers
        const linkupKey = yield* getApiKey("linkup");
        if (linkupKey) {
          providers.push({
            name: "linkup",
            apiKey: linkupKey,
            execute: executeLinkupSearch,
          });
        }

        const exaKey = yield* getApiKey("exa");
        if (exaKey) {
          providers.push({
            name: "exa",
            apiKey: exaKey,
            execute: executeExaSearch,
          });
        }

        const parallelKey = yield* getApiKey("parallel");
        if (parallelKey) {
          providers.push({
            name: "parallel",
            apiKey: parallelKey,
            execute: executeParallelSearch,
          });
        }

        if (providers.length === 0) {
          return {
            success: false,
            result: null,
            error:
              "No search provider API keys found. Please configure 'web_search.<provider>.api_key' (e.g., 'web_search.parallel.api_key').",
          };
        }

        // Sort providers by priority order
        const sortedProviders = providers.sort((a, b) => {
          const aIndex = priorityOrder.indexOf(a.name);
          const bIndex = priorityOrder.indexOf(b.name);
          // If not in priority order, put at end
          if (aIndex === -1 && bIndex === -1) return 0;
          if (aIndex === -1) return 1;
          if (bIndex === -1) return -1;
          return aIndex - bIndex;
        });

        // Try providers in priority order
        for (const provider of sortedProviders) {
          yield* logger.info(`Attempting search with ${provider.name} provider...`);
          const result = yield* provider.execute(args, provider.apiKey).pipe(
            Effect.catchAll((error) => {
              return logger
                .warn(
                  `${provider.name} search failed: ${error instanceof Error ? error.message : String(error)}`,
                )
                .pipe(Effect.map(() => null as WebSearchResult | null));
            }),
          );

          if (result) {
            return {
              success: true,
              result,
            };
          }
        }

        return {
          success: false,
          result: null,
          error: "All search providers failed.",
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

let cachedLinkupClient: LinkupClient | null = null;
let cachedExaClient: Exa | null = null;
let cachedParallelClient: Parallel | null = null;

/**
 * Execute a Linkup search
 */
function executeLinkupSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (!cachedLinkupClient) {
      cachedLinkupClient = new LinkupClient({
        apiKey: apiKey,
      });
    }

    const client = cachedLinkupClient;

    yield* logger.info(
      `Executing Linkup search for query: "${args.query}" with depth: ${args.depth ?? "standard"}`,
    );

    const response = yield* Effect.tryPromise({
      try: async () => {
        const searchParams: Parameters<typeof client.search>[0] = {
          query: args.query,
          depth: args.depth ?? "standard",
          outputType: "searchResults",
          includeImages: args.includeImages ?? false,
          maxResults: MAX_RESULTS,
        };

        if (args.fromDate) {
          searchParams.fromDate = new Date(args.fromDate);
        }
        if (args.toDate) {
          searchParams.toDate = new Date(args.toDate);
        }

        return await client.search(searchParams);
      },
      catch: (error) =>
        new Error(
          `Linkup search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const results: WebSearchItem[] = response.results.map((result) => ({
      title: result.name || "",
      url: result.url || "",
      snippet: result.type === "text" ? result.content : "",
      source: result.name,
    }));

    yield* logger.info(`Linkup search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      timestamp: new Date().toISOString(),
      provider: "linkup" as const,
    };
  });
}

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
