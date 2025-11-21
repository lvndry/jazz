import { Effect } from "effect";
import Exa from "exa-js";
import {
  LinkupClient,
  type SearchDepth
} from "linkup-sdk";
import { z } from "zod";
import { AgentConfigService, type ConfigService } from "../../../services/config";
import { LoggerServiceTag, type LoggerService } from "../../../services/logger";
import { defineTool } from "./base-tool";
import { type ToolExecutionResult } from "./tool-registry";

export interface WebSearchArgs extends Record<string, unknown> {
  readonly query: string;
  readonly depth?: SearchDepth;
  readonly includeImages?: boolean;
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
  readonly provider: "linkup" | "exa";
}

export function createWebSearchTool(): ReturnType<
  typeof defineTool<ConfigService | LoggerService, WebSearchArgs>
> {
  return defineTool<ConfigService | LoggerService, WebSearchArgs>({
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
      })
      .strict(),
    validate: (args) => {
      const result = (
        z
          .object({
            query: z.string().min(1),
            depth: z.enum(["standard", "deep"]).optional(),
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
    ): Effect.Effect<ToolExecutionResult, Error, ConfigService | LoggerService> {
      return Effect.gen(function* () {
        const config = yield* AgentConfigService;
        const logger = yield* LoggerServiceTag;

        // Try Linkup if API key is present
        const linkupKey = yield* config.getOrElse("linkup.apiKey", "");
        if (linkupKey) {
          yield* logger.info("Attempting search with Linkup provider...");
          const linkupResult = yield* executeLinkupSearch(args, linkupKey).pipe(
            Effect.catchAll((error) => {
              return logger.warn(`Linkup search failed: ${error.message}`).pipe(
                Effect.map(() => null as WebSearchResult | null)
              );
            }),
          );

          if (linkupResult) {
            return {
              success: true,
              result: linkupResult,
            };
          }
        }

        // Try Exa if API key is present
        const exaKey = yield* config.getOrElse("exa.apiKey", "");
        if (exaKey) {
          yield* logger.info("Attempting search with Exa provider...");
          const exaResult = yield* executeExaSearch(args, exaKey).pipe(
            Effect.catchAll((error) => {
              return logger.warn(`Exa search failed: ${error.message}`).pipe(
                Effect.map(() => null as WebSearchResult | null)
              );
            }),
          );

          if (exaResult) {
            return {
              success: true,
              result: exaResult,
            };
          }
        }

        if (!linkupKey && !exaKey) {
          return {
            success: false,
            result: null,
            error: "No search provider API keys found. Please configure 'linkup.apiKey' or 'exa.apiKey'.",
          };
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
        return await client.search({
          query: args.query,
          depth: args.depth ?? "standard",
          outputType: "searchResults",
          includeImages: args.includeImages ?? false,
        });
      },
      catch: (error) =>
        new Error(`Linkup search failed: ${error instanceof Error ? error.message : String(error)}`),
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
        return await exa.search(args.query, {
          type: "auto",
          useAutoprompt: true,
        });
      },
      catch: (error) =>
        new Error(
          `Exa search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
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
