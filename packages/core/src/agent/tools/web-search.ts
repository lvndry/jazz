/**
 * `web_search` tool, backed by the agent's ordered search providers and normalized
 * to one result shape. A failing provider hands the query to the next one; treg
 * itself tries TinyFish free before a capped paid route.
 */

import { Effect, Option, Schedule } from "effect";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type {
  ToolReadiness,
  ToolReadinessContext,
  ToolReadinessRequirements,
} from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import type { WebSearchProviderName } from "@/core/types/config";
import { toError } from "@/core/utils/errors";
import { defineTool, makeZodValidator } from "./base-tool";
import { executeTregSearch } from "./treg-search";
import {
  classifySearchFailure,
  processWebSearchCooldowns,
  resolveWebSearchRoute,
  type SearchFailureKind,
  type WebSearchCooldowns,
} from "./web-search-route";

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
  /** Providers tried before `provider` answered, in the order they failed. */
  readonly fallbacks?: readonly WebSearchFallbackStep[];
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
  { name: "Keenable", value: "keenable" },
  { name: "treg (TinyFish first, paid fallback)", value: "treg" },
] as const;

/** A provider's short display name, e.g. "Brave" or "treg". */
export function webSearchProviderLabel(provider: WebSearchProviderName): string {
  const name = WEB_SEARCH_PROVIDERS.find((entry) => entry.value === provider)?.name ?? provider;
  return name.replace(/ \(.*\)$/, "");
}

/** Maximum number of results to return. */
export const DEFAULT_MAX_RESULTS = 20;

const webSearchSchema = z
  .object({
    query: z
      .string()
      .min(1, "query cannot be empty")
      .max(5000, "query cannot be longer than 5000 characters")
      .describe("Specific research goal with context; site: and filetype: operators go here."),
    searchQueries: z
      .array(
        z
          .string()
          .min(1)
          .max(200, "each search query must be 200 characters or less")
          .describe("3–6 word keyword phrase."),
      )
      .min(1)
      .max(5)
      .optional()
      .describe("Extra keyword phrases."),
    searchDepth: z
      .enum(["fast", "standard", "deep"])
      .optional()
      .describe("Default standard; deep does multi-step research."),
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be in ISO 8601 format (YYYY-MM-DD)")
      .optional()
      .describe("Earliest publish date, YYYY-MM-DD."),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be in ISO 8601 format (YYYY-MM-DD)")
      .optional()
      .describe("Latest publish date, YYYY-MM-DD."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`Default ${DEFAULT_MAX_RESULTS}.`),
    sourceType: z
      .enum(["web", "news", "academic", "company", "people", "financial"])
      .optional()
      .describe("Preferred source kind. Default web."),
  })
  .strict() as z.ZodType<WebSearchArgs>;

/**
 * Ready when some provider in the agent's chain has a key, or when the chain is empty and the
 * model's own provider hosts web search (the LLM layer then swaps in that native tool).
 */
export function webSearchReadiness(
  context: ToolReadinessContext,
): Effect.Effect<ToolReadiness, never, ToolReadinessRequirements> {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const llm = yield* LLMServiceTag;
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    const hostsNativeSearch = yield* llm
      .supportsNativeWebSearch(context.agent.config.llm.provider)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    const route = yield* resolveWebSearchRoute(
      config,
      context.agent.config.webSearchProviders,
      hostsNativeSearch,
    );

    if (route.kind === "external") {
      return { ready: true } as const;
    }

    if (hostsNativeSearch) {
      return { ready: true } as const;
    }

    if (Option.isSome(logger)) {
      yield* logger.value.debug("Web search readiness: no usable route", {
        missingKeys: route.missingKeys.join(",") || "none",
        llmProvider: context.agent.config.llm.provider,
      });
    }

    const [firstMissing] = route.missingKeys;
    if (firstMissing === undefined) {
      return {
        ready: false,
        reason: "not_configured",
        remedy: "Run `jazz config set web_search.<provider>.api_key` for at least one provider.",
      } as const;
    }
    return {
      ready: false,
      reason: "missing_credential",
      remedy: `Run \`jazz config set web_search.${firstMissing}.api_key\` or set the provider's environment variable.`,
    } as const;
  });
}

/** One provider that was tried and failed before the provider that answered. */
export interface WebSearchFallbackStep {
  readonly provider: WebSearchProviderName;
  readonly reason: SearchFailureKind;
  readonly error: string;
}

export function createWebSearchTool(
  cooldowns: WebSearchCooldowns = processWebSearchCooldowns,
): ReturnType<typeof defineTool<AgentConfigService | LoggerService, WebSearchArgs>> {
  return defineTool<AgentConfigService | LoggerService, WebSearchArgs>({
    name: "web_search",
    disclosure: "public",
    // The destinations are the operator's configured providers, but the query is the model's
    // prose, sent verbatim to third parties under the operator's accounts.
    egress: true,
    description:
      "Search the public web for titles, URLs and snippets; read full pages with web_fetch. Parameters besides query are hints some providers ignore. On error, report it and cite only sources you retrieved.",
    tags: ["web", "search"],
    parameters: webSearchSchema,
    validate: makeZodValidator(webSearchSchema),
    ready: webSearchReadiness,
    handler: function webSearchHandler(
      args: WebSearchArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult, Error, AgentConfigService | LoggerService> {
      return Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        const logger = yield* LoggerServiceTag;

        const route = yield* resolveWebSearchRoute(
          config,
          context.parentAgent?.config.webSearchProviders,
          false,
        );

        if (route.kind === "builtin") {
          const [firstMissing] = route.missingKeys;
          yield* logger.warn("Web search has no provider with a key", {
            missingKeys: route.missingKeys.join(",") || "none",
          });
          return {
            success: false,
            result: null,
            error:
              firstMissing === undefined
                ? "No web search provider has an API key. Set 'web_search.<provider>.api_key' in your Jazz config."
                : `No API key configured for ${route.missingKeys.join(", ")}. Set 'web_search.${firstMissing}.api_key' in your Jazz config.`,
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
          keenable: executeKeenableSearch,
          treg: executeTregSearch,
        };

        const ordered = cooldowns.order(route.chain);
        yield* logger.debug("Web search started", {
          chain: ordered.map((link) => link.provider).join(","),
          cooling: ordered
            .filter((link) => cooldowns.isCooling(link.provider))
            .map((link) => link.provider)
            .join(","),
          missingKeys: route.missingKeys.join(","),
        });

        const fallbacks: WebSearchFallbackStep[] = [];
        for (const link of ordered) {
          const startedAt = Date.now();
          const attempt = yield* executorMap[link.provider](args, link.apiKey).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) =>
              Effect.succeed({ ok: false as const, message: toError(error).message }),
            ),
          );

          if (attempt.ok) {
            cooldowns.clear(link.provider);
            yield* logger.debug("Web search provider answered", {
              provider: link.provider,
              durationMs: Date.now() - startedAt,
              fallbackCount: fallbacks.length,
            });
            const result: WebSearchResult =
              fallbacks.length > 0 ? { ...attempt.result, fallbacks } : attempt.result;
            return {
              success: true as const,
              result,
              untrusted: {
                kind: "external" as const,
                source: `web_search results from ${link.provider}`,
              },
            };
          }

          const reason = classifySearchFailure(attempt.message);
          const cooldownMs = cooldowns.record(link.provider, reason);
          fallbacks.push({ provider: link.provider, reason, error: attempt.message });
          yield* logger.warn("Web search provider failed", {
            provider: link.provider,
            reason,
            cooldownMs,
            durationMs: Date.now() - startedAt,
            remaining: ordered.length - fallbacks.length,
          });
        }

        yield* logger.error("Web search failed on every provider", {
          providers: fallbacks.map((step) => `${step.provider}:${step.reason}`).join(","),
        });
        return {
          success: false as const,
          result: null,
          error: `Web search failed on every provider: ${fallbacks
            .map((step) => `${step.provider} (${step.reason}): ${step.error}`)
            .join("; ")}`,
        };
      });
    },
    createSummary: function createSearchSummary(result: ToolExecutionResult): string | undefined {
      if (!result.success || !result.result) {
        return undefined;
      }

      const searchResult = result.result as WebSearchResult;
      const fellBack =
        searchResult.fallbacks && searchResult.fallbacks.length > 0
          ? ` after ${searchResult.fallbacks.map((step) => `${step.provider} ${step.reason}`).join(", ")}`
          : "";
      return `Found ${searchResult.totalResults} results for "${searchResult.query}" using ${searchResult.provider}${fellBack}`;
    },
  });
}

/** Longest slice of an error body kept in a failure message. */
const ERROR_BODY_MAX_CHARS = 300;

/**
 * "422 SUBSCRIPTION_TOKEN_INVALID …": the status plus the start of the body, because some
 * providers (Brave) report a refused key as a bare 422 and only the body says why.
 */
async function httpFailureMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return [res.status, res.statusText, body.slice(0, ERROR_BODY_MAX_CHARS)]
    .filter((part) => part !== "")
    .join(" ");
}

const SEARCH_RETRY_SCHEDULE = Schedule.jittered(Schedule.exponential("1 second")).pipe(
  Schedule.upTo({ times: 3 }),
);

/**
 * Client, auth, quota and rate-limit errors fail the same way on retry, so they go straight to the
 * next provider instead of spending ~7s of backoff on one that will not answer.
 */
const NON_RETRYABLE_CLIENT_ERROR = /\b(400|404|422)\b/;

const SEARCH_RETRY_POLICY = {
  schedule: SEARCH_RETRY_SCHEDULE,
  while: (error: Error) =>
    !NON_RETRYABLE_CLIENT_ERROR.test(error.message) &&
    classifySearchFailure(error.message) === "other",
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
    const { default: Exa } = yield* Effect.promise(() => import("exa-js"));
    const exa = new Exa(apiKey);

    yield* logger.debug("Web search provider request started", {
      provider: "exa",
      queryLength: args.query.length,
    });

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
        catch: (error) => new Error(`Exa search failed: ${toError(error).message}`),
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

    yield* logger.info("Web search provider request completed", {
      provider: "exa",
      resultCount: results.length,
    });

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
    const { default: Parallel } = yield* Effect.promise(() => import("parallel-web"));
    const parallel = new Parallel({ apiKey });

    yield* logger.debug("Web search provider request started", {
      provider: "parallel",
      queryLength: args.query.length,
    });

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
        catch: (error) => new Error(`Parallel search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.excerpts?.join(" ") || "",
      ...(result.publish_date ? { publishedDate: result.publish_date } : {}),
    }));

    yield* logger.info("Web search provider request completed", {
      provider: "parallel",
      resultCount: results.length,
    });

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "parallel" as const,
    };
  });
}

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_TIMEOUT_MS = 60_000;
const KEENABLE_SNIPPET_MAX_CHARS = 1_000;

/** The fields this tool reads from Keenable's `/v1/search` response. */
interface KeenableSearchResponse {
  readonly results?: readonly {
    readonly title?: string;
    readonly url?: string;
    readonly description?: string;
    readonly snippet?: string;
  }[];
}

function executeKeenableSearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.debug("Web search provider request started", {
      provider: "keenable",
      queryLength: args.query.length,
    });

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(KEENABLE_SEARCH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              "X-Keenable-Title": "Jazz",
            },
            body: JSON.stringify({
              query: args.query,
              max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
            }),
            signal: AbortSignal.timeout(KEENABLE_TIMEOUT_MS),
          });

          if (!res.ok) {
            throw new Error(await httpFailureMessage(res));
          }

          return (await res.json()) as KeenableSearchResponse;
        },
        catch: (error) => new Error(`Keenable search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results ?? [])
      .filter((result) => Boolean(result.url))
      .map((result) => ({
        title: result.title || "",
        url: result.url || "",
        snippet: result.description || (result.snippet ?? "").slice(0, KEENABLE_SNIPPET_MAX_CHARS),
      }));

    yield* logger.info("Web search provider request completed", {
      provider: "keenable",
      resultCount: results.length,
    });

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "keenable" as const,
    };
  });
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/**
 * What `@tavily/core` used as its default request timeout. `fetch` has none, so
 * without this a stalled connection would hang the tool run instead of failing.
 */
const TAVILY_TIMEOUT_MS = 60_000;

/** The fields this tool reads from Tavily's `/search` response. */
interface TavilySearchResponse {
  readonly results?: readonly {
    readonly title?: string;
    readonly url?: string;
    readonly content?: string;
    readonly raw_content?: string;
    readonly published_date?: string;
    readonly score?: number;
  }[];
}

/**
 * Calls Tavily's REST endpoint directly, like every other provider in this file.
 *
 * Not through `@tavily/core`: that SDK depends on `js-tiktoken`, whose embedded
 * BPE tables were 5.6MB of the compiled binary's 20MB of JavaScript — a quarter
 * of the bundle, and about 55ms of parse on every `jazz` invocation, for a token
 * counter this tool never asks it to use (jazz counts with `gpt-tokenizer`). The
 * request and response shapes below are the SDK's own wire format.
 */
function executeTavilySearch(
  args: WebSearchArgs,
  apiKey: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.debug("Web search provider request started", {
      provider: "tavily",
      queryLength: args.query.length,
    });

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(TAVILY_SEARCH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              query: args.query,
              search_depth: "basic",
              max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
              include_raw_content: false,
              ...(args.fromDate ? { start_date: args.fromDate } : {}),
              ...(args.toDate ? { end_date: args.toDate } : {}),
            }),
            signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
          });

          if (!res.ok) {
            throw new Error(await httpFailureMessage(res));
          }

          return (await res.json()) as TavilySearchResponse;
        },
        catch: (error) => new Error(`Tavily search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results ?? []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.raw_content || result.content || "",
      ...(result.published_date ? { publishedDate: result.published_date } : {}),
      ...(result.score !== undefined ? { metadata: { score: result.score } } : {}),
    }));

    yield* logger.info("Web search provider request completed", {
      provider: "tavily",
      resultCount: results.length,
    });

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

    yield* logger.debug("Web search provider request started", {
      provider: "brave",
      queryLength: args.query.length,
    });

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
            throw new Error(await httpFailureMessage(res));
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
        catch: (error) => new Error(`Brave search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.web?.results || []).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: [result.description, ...(result.extra_snippets ?? [])].filter(Boolean).join("\n\n"),
      ...(result.page_age ? { publishedDate: result.page_age } : {}),
    }));

    yield* logger.info("Web search provider request completed", {
      provider: "brave",
      resultCount: results.length,
    });

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
    const { default: Perplexity } = yield* Effect.promise(
      () => import("@perplexity-ai/perplexity_ai"),
    );
    const client = new Perplexity({
      apiKey,
      defaultHeaders: { "X-Pplx-Integration": "jazz" },
    });

    yield* logger.debug("Web search provider request started", {
      provider: "perplexity",
      queryLength: args.query.length,
    });

    const response = yield* Effect.retry(
      Effect.tryPromise({
        try: () =>
          client.search.create({
            query: args.searchQueries ?? args.query,
            max_results: args.maxResults ?? DEFAULT_MAX_RESULTS,
            ...(args.fromDate ? { search_after_date_filter: toPerplexityDate(args.fromDate) } : {}),
            ...(args.toDate ? { search_before_date_filter: toPerplexityDate(args.toDate) } : {}),
          }),
        catch: (error) => new Error(`Perplexity search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = (response.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      ...(result.date ? { publishedDate: result.date } : {}),
    }));

    yield* logger.info("Web search provider request completed", {
      provider: "perplexity",
      resultCount: results.length,
    });

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
    const { LinkupClient } = yield* Effect.promise(() => import("linkup-sdk"));
    const client = new LinkupClient({ apiKey });

    yield* logger.debug("Web search provider request started", {
      provider: "linkup",
      queryLength: args.query.length,
    });

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
        catch: (error) => new Error(`Linkup search failed: ${toError(error).message}`),
      }),
      SEARCH_RETRY_POLICY,
    );

    const results: WebSearchItem[] = [];
    for (const result of response.results ?? []) {
      if (result.type !== "text") {
        continue;
      }
      results.push({
        title: result.name,
        url: result.url,
        snippet: result.content,
      });
    }

    yield* logger.info("Web search provider request completed", {
      provider: "linkup",
      resultCount: results.length,
    });

    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "linkup" as const,
    };
  });
}
