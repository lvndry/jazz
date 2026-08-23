import Perplexity from "@perplexity-ai/perplexity_ai";
import { tavily } from "@tavily/core";
import { Effect, Schedule } from "effect";
import Exa from "exa-js";
import { LinkupClient } from "linkup-sdk";
import Parallel from "parallel-web";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import type { WebSearchProviderName } from "@/core/types/config";
import { defineTool, makeZodValidator } from "./base-tool";

export type SearchDepth = "fast" | "standard" | "deep";

export type SourceType = "web" | "news" | "academic" | "company" | "people" | "financial";

export interface WebSearchArgs extends Record<string, unknown> {
  readonly query: string;
  readonly searchQueries?: string[];
  readonly maxResults?: number;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly sourceType?: SourceType;
  readonly searchDepth?: SearchDepth;
}

export interface WebSearchItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface WebSearchResult {
  readonly results: readonly WebSearchItem[];
  readonly totalResults: number;
  readonly query: string;
  readonly completedAt: string;
  readonly provider: WebSearchProviderName;
}

/**
 * Available web search providers with their display names
 * Used by CLI and other parts of the system to list available providers
 */
export const WEB_SEARCH_PROVIDERS = [
  { name: "Brave", value: "brave" },
  { name: "Perplexity", value: "perplexity" },
  { name: "Parallel", value: "parallel" },
  { name: "Exa", value: "exa" },
  { name: "Tavily", value: "tavily" },
  { name: "Linkup", value: "linkup" },
] as const;

/** Maximum number of results to return. */
export const DEFAULT_MAX_RESULTS = 20;

const webSearchSchema = z
  .object({
    query: z
      .string()
      .min(1, "query cannot be empty")
      .max(5000, "query cannot be longer than 5000 characters")
      .describe(
        "Natural-language description of the web research goal, including source or freshness guidance and broader context. Be specific — 'French energy company Total website' finds the right company; 'Total' does not.",
      ),
    searchQueries: z
      .array(
        z
          .string()
          .min(1)
          .max(200, "each search query must be 200 characters or less")
          .describe("A short keyword phrase, 3–6 words."),
      )
      .min(1)
      .max(5)
      .optional()
      .describe("Optional extra keyword phrases, 3–6 words each, if the provider supports them."),
    searchDepth: z
      .enum(["fast", "standard", "deep"])
      .optional()
      .describe(
        "How thorough the search should be. 'fast' for a quick lookup, 'standard' (default) for a balanced search, 'deep' for multi-step research. Some providers ignore this.",
      ),
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be in ISO 8601 format (YYYY-MM-DD)")
      .optional()
      .describe(
        "Only return results published on or after this date (YYYY-MM-DD). Some providers ignore this.",
      ),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be in ISO 8601 format (YYYY-MM-DD)")
      .optional()
      .describe(
        "Only return results published on or before this date (YYYY-MM-DD). Some providers ignore this.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        `Maximum number of results to return. Default ${DEFAULT_MAX_RESULTS}, hard cap 100.`,
      ),
    sourceType: z
      .enum(["web", "news", "academic", "company", "people", "financial"])
      .optional()
      .describe(
        "Prefer this kind of source: news, academic, company, people, financial, or web (default). Some providers ignore this.",
      ),
  })
  .strict() as z.ZodType<WebSearchArgs>;

export function createWebSearchTool(): ReturnType<
  typeof defineTool<AgentConfigService | LoggerService, WebSearchArgs>
> {
  return defineTool<AgentConfigService | LoggerService, WebSearchArgs>({
    name: "web_search",
    description:
      "Search the public web. Each result has a title, url, snippet, and sometimes a publishedDate. This does not fetch full pages — follow up with web_fetch for HTML or text, or http_request for APIs and POST. " +
      "Put operators such as site: and filetype: in query. fromDate, toDate, searchDepth, sourceType, and searchQueries are hints; some providers ignore them. If search is unavailable the tool returns an error — do not invent sources.",
    tags: ["web", "search"],
    parameters: webSearchSchema,
    validate: makeZodValidator(webSearchSchema),
    handler: function webSearchHandler(
      args: WebSearchArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult, Error, AgentConfigService | LoggerService> {
      return Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        const logger = yield* LoggerServiceTag;

        // Resolve provider: per-agent setting takes priority over global config.
        const agentProvider = context.parentAgent?.config.webSearchProvider;
        const appConfig = yield* config.appConfig;
        const selectedProvider: WebSearchProviderName | undefined =
          agentProvider ?? appConfig.web_search?.provider;

        if (!selectedProvider) {
          return {
            success: false,
            result: null,
            error: `No web search provider configured. Set 'webSearchProvider' in the agent config or 'web_search.provider' in your Jazz config.`,
          };
        }

        const apiKey = yield* config.getOrElse(`web_search.${selectedProvider}.api_key`, "");
        if (!apiKey) {
          return {
            success: false,
            result: null,
            error: `No API key configured for ${selectedProvider}. Set 'web_search.${selectedProvider}.api_key' in your Jazz config.`,
          };
        }

        const executorMap: Record<
          WebSearchProviderName,
          (
            args: WebSearchArgs,
            apiKey: string,
          ) => Effect.Effect<WebSearchResult, Error, LoggerService>
        > = {
          exa: executeExaSearch,
          parallel: (args, apiKey) =>
            executeParallelSearch(args, apiKey, context.model ?? "", context.conversationId ?? ""),
          tavily: executeTavilySearch,
          brave: executeBraveSearch,
          perplexity: executePerplexitySearch,
          linkup: executeLinkupSearch,
        };

        const executor = executorMap[selectedProvider];

        yield* logger.info(`Executing search with ${selectedProvider} provider...`);

        return yield* executor(args, apiKey).pipe(
          Effect.map((result) => ({ success: true as const, result })),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const message = error instanceof Error ? error.message : String(error);
              yield* logger.error(`${selectedProvider} search failed: ${message}`);
              return {
                success: false as const,
                result: null,
                error: `${selectedProvider} search failed: ${message}`,
              };
            }),
          ),
        );
      });
    },
    createSummary: function createSearchSummary(result: ToolExecutionResult): string | undefined {
      if (!result.success || !result.result) return undefined;

      const searchResult = result.result as WebSearchResult;
      return `Found ${searchResult.totalResults} results for "${searchResult.query}" using ${searchResult.provider}`;
    },
  });
}

const SEARCH_RETRY_SCHEDULE = Schedule.intersect(
  Schedule.recurs(3),
  Schedule.jittered(Schedule.exponential("1 second")),
);

// Auth and client errors never succeed on retry; retrying a 401 four times
// costs ~12s per search call for the same failure.
const NON_RETRYABLE_SEARCH_ERROR = /\b(400|401|403|404|422)\b|invalid api key|unauthorized/i;

const SEARCH_RETRY_POLICY = {
  schedule: SEARCH_RETRY_SCHEDULE,
  while: (error: Error) => !NON_RETRYABLE_SEARCH_ERROR.test(error.message),
} as const;

/**
 * Execute an Exa search
 */
function executeExaSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  type ExaCategory =
    "company" | "publication" | "news" | "personal site" | "financial report" | "people";
  type ExaSearchType = "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";

  const sourceTypeToCategory: Partial<Record<SourceType, ExaCategory>> = {
    news: "news",
    academic: "publication",
    company: "company",
    people: "people",
    financial: "financial report",
  };

  const searchDepthToType: Record<SearchDepth, ExaSearchType> = {
    fast: "fast",
    standard: "auto",
    deep: "deep",
  };

  const noDateFilterCategories = new Set<ExaCategory>(["company", "people"]);

  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const exa = new Exa(apiKey);

    yield* logger.info(`Executing Exa search for query: "${args.query}"`);

    const exaCategory = args.sourceType ? sourceTypeToCategory[args.sourceType] : undefined;
    const suppressDateFilters = exaCategory ? noDateFilterCategories.has(exaCategory) : false;

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () => {
          const baseOptions = {
            type: searchDepthToType[args.searchDepth ?? "standard"],
            numResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
            contents: { highlights: true, text: true },
            ...(exaCategory ? { category: exaCategory } : {}),
            ...(suppressDateFilters
              ? {}
              : {
                  ...(args.fromDate ? { startPublishedDate: args.fromDate } : {}),
                  ...(args.toDate ? { endPublishedDate: args.toDate } : {}),
                }),
          };
          return exa.search(args.query, baseOptions as Parameters<typeof exa.search>[1]);
        },
        catch: (error) =>
          new Error(`Exa search failed: ${error instanceof Error ? error.message : String(error)}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: Array.isArray((result as Record<string, unknown>)["highlights"])
        ? ((result as Record<string, unknown>)["highlights"] as string[]).join("\n\n")
        : "",
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      metadata: {
        text: (result as Record<string, unknown>)["text"],
      },
    }));

    yield* logger.info(`Exa search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "exa" as const,
    };
  });
}

function executeParallelSearch(
  args: WebSearchArgs,
  apiKey: string,
  clientModel: string,
  conversationId: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  const searchDepthToMode: Record<SearchDepth, "basic" | "advanced"> = {
    fast: "basic",
    standard: "advanced",
    deep: "advanced",
  };

  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const parallel = new Parallel({ apiKey });

    yield* logger.info(`Executing Parallel search for query: "${args.query}"`);

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () =>
          parallel.search({
            search_queries: args.searchQueries ?? [args.query],
            objective: args.query,
            mode: searchDepthToMode[args.searchDepth ?? "standard"],
            ...(clientModel ? { client_model: clientModel } : {}),
            ...(conversationId ? { session_id: conversationId } : {}),
            advanced_settings: {
              max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
              ...(args.fromDate ? { source_policy: { after_date: args.fromDate } } : {}),
            },
          }),
        catch: (error) =>
          new Error(
            `Parallel search failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.excerpts?.join(" ") || "",
      ...(result.publish_date ? { publishedDate: result.publish_date } : {}),
    }));

    yield* logger.info(`Parallel search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "parallel" as const,
    };
  });
}

function executeTavilySearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const client = tavily({ apiKey });

    yield* logger.info(`Executing Tavily search for query: "${args.query}"`);

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () =>
          client.search(args.query, {
            searchDepth: "basic",
            maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
            includeRawContent: false,
            ...(args.fromDate ? { startDate: args.fromDate } : {}),
            ...(args.toDate ? { endDate: args.toDate } : {}),
          }),
        catch: (error) =>
          new Error(
            `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.rawContent || result.content || "",
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      ...(result.score !== undefined ? { metadata: { score: result.score } } : {}),
    }));

    yield* logger.info(`Tavily search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "tavily" as const,
    };
  });
}

const BRAVE_MAX_COUNT = 20;

function executeBraveSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.info(`Executing Brave search for query: "${args.query}"`);

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: async () => {
          const url = new URL("https://api.search.brave.com/res/v1/web/search");
          url.searchParams.append("q", args.query);
          url.searchParams.append(
            "count",
            Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, BRAVE_MAX_COUNT).toString(),
          );
          url.searchParams.append("extra_snippets", "true");
          if (args.fromDate) {
            const to = args.toDate ?? new Date().toISOString().slice(0, 10);
            url.searchParams.append("freshness", `${args.fromDate}to${to}`);
          }

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
                extra_snippets?: string[];
                page_age?: string;
              }>;
            };
          };
        },
        catch: (error) =>
          new Error(
            `Brave search failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.web?.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: [result.description, ...(result.extra_snippets ?? [])].filter(Boolean).join("\n\n"),
      ...(result.page_age ? { publishedDate: result.page_age } : {}),
    }));

    yield* logger.info(`Brave search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "brave" as const,
    };
  });
}

function toPerplexityDate(isoDate: string): string {
  const [year = "", month = "", day = ""] = isoDate.split("-");
  return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
}

function executePerplexitySearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const client = new Perplexity({ apiKey });

    yield* logger.info(`Executing Perplexity search for query: "${args.query}"`);

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () =>
          client.search.create({
            query: args.searchQueries ?? args.query,
            max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
            ...(args.fromDate ? { search_after_date_filter: toPerplexityDate(args.fromDate) } : {}),
            ...(args.toDate ? { search_before_date_filter: toPerplexityDate(args.toDate) } : {}),
          }),
        catch: (error) =>
          new Error(
            `Perplexity search failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      ...(result.date ? { publishedDate: result.date } : {}),
    }));

    yield* logger.info(`Perplexity search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "perplexity" as const,
    };
  });
}

function executeLinkupSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  const searchDepthToLinkup: Record<SearchDepth, "fast" | "standard" | "deep"> = {
    fast: "fast",
    standard: "standard",
    deep: "deep",
  };

  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const client = new LinkupClient({ apiKey });

    yield* logger.info(`Executing Linkup search for query: "${args.query}"`);

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () =>
          client.search({
            query: args.query,
            depth: searchDepthToLinkup[args.searchDepth ?? "standard"],
            outputType: "searchResults",
            includeImages: false,
            maxResults: args.maxResults ?? DEFAULT_MAX_RESULTS,
            ...(args.fromDate ? { fromDate: new Date(args.fromDate) } : {}),
            ...(args.toDate ? { toDate: new Date(args.toDate) } : {}),
          }),
        catch: (error) =>
          new Error(
            `Linkup search failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = [];
    for (const result of response.results ?? []) {
      if (result.type !== "text") continue;
      results.push({
        title: result.name,
        url: result.url,
        snippet: result.content,
      });
    }

    yield* logger.info(`Linkup search found ${results.length} results`);

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "linkup" as const,
    };
  });
}
