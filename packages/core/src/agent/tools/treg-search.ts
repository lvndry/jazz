/**
 * Treg search integration. Makes one free-only TinyFish call, then retries through
 * treg's paid provider router (excluding TinyFish) on an error or empty results.
 * A per-call cost ceiling limits what one fallback may charge. The caller supplies
 * the treg token from Jazz's secret store; it never appears in URLs or logs.
 */
import { Effect } from "effect";
import { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { WebSearchArgs, WebSearchItem, WebSearchResult } from "./web-search";

const TINYFISH_SEARCH_URL = "https://treg.to/call/tinyfish.web.search";
const TREG_SEARCH_URL = "https://treg.to/call/treg.web.search";
const PAID_FALLBACK_MAX_COST_USD = "0.05";

const resultRow = z
  .object({
    title: z.string().optional(),
    url: z.string().url(),
    snippet: z.string().optional(),
    date: z.string().optional(),
  })
  .passthrough();
const freeResponse = z.object({ results: z.array(resultRow) }).passthrough();
const routedResponse = z
  .object({
    output: z.object({ results: z.array(resultRow) }).passthrough(),
    _treg: z.object({ served_by: z.string().optional() }).optional(),
  })
  .passthrough();

type SearchResponse = {
  readonly results: z.infer<typeof resultRow>[];
  readonly servedBy: string;
};

/** Call TinyFish's free endpoint directly, not a router that can prefer owned paid keys. */
async function callTinyFish(args: WebSearchArgs, token: string): Promise<SearchResponse> {
  const url = new URL(TINYFISH_SEARCH_URL);
  url.searchParams.set("query", args.query);
  url.searchParams.set("domain_type", "web");
  if (args.fromDate) url.searchParams.set("after_date", args.fromDate);
  if (args.toDate) url.searchParams.set("before_date", args.toDate);
  const response = await fetch(url, {
    headers: { "X-Treg-Token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TinyFish returned HTTP ${response.status}`);
  const parsed = freeResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error("TinyFish returned an invalid search response");
  return { results: parsed.data.results, servedBy: "tinyfish.web.search" };
}

/** Make one cost-capped routed call, excluding the provider already tried. */
async function callRouted(args: WebSearchArgs, token: string): Promise<SearchResponse> {
  const response = await fetch(TREG_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Treg-Token": token,
      "X-Treg-Route-Max-Cost": PAID_FALLBACK_MAX_COST_USD,
      "X-Treg-Route-Exclude": "tinyfish",
    },
    body: JSON.stringify({ q: args.query, limit: args.maxResults ?? 20 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`treg returned HTTP ${response.status}`);
  const parsed = routedResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error("treg returned an invalid search response");
  return {
    results: parsed.data.output.results,
    servedBy: parsed.data._treg?.served_by ?? "treg.web.search",
  };
}

/** Search free first; pay at most five cents for one fallback call if it fails. */
export function executeTregSearch(
  args: WebSearchArgs,
  token: string,
): Effect.Effect<WebSearchResult, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const free = yield* Effect.either(
      Effect.tryPromise({
        try: () => callTinyFish(args, token),
        catch: () => new Error("Free treg search unavailable"),
      }),
    );
    let response: SearchResponse | undefined = free._tag === "Right" ? free.right : undefined;
    if (!response || response.results.length === 0) {
      yield* logger.info("Treg search using capped paid fallback", { provider: "treg" });
      response = yield* Effect.tryPromise({
        try: () => callRouted(args, token),
        catch: () => new Error("treg paid fallback failed or exceeded its cost limit"),
      });
    }

    const servedBy = response.servedBy;
    const results: WebSearchItem[] = response.results
      .slice(0, args.maxResults ?? 20)
      .map((item) => ({
        title: item.title ?? "",
        url: item.url,
        snippet: item.snippet ?? "",
        ...(item.date && /^\d{4}-\d{2}-\d{2}/.test(item.date) ? { publishedDate: item.date } : {}),
        ...(servedBy ? { metadata: { servedBy } } : {}),
      }));
    yield* logger.info("Web search provider request completed", {
      provider: "treg",
      resultCount: results.length,
      ...(servedBy ? { servedBy } : {}),
    });
    return {
      results,
      totalResults: results.length,
      query: args.query,
      completedAt: new Date().toISOString(),
      provider: "treg" as const,
    };
  });
}
