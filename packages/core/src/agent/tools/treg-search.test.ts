/** Tests the free-first, capped paid-fallback treg search contract without network calls. */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { executeTregSearch } from "./treg-search";

const originalFetch = global.fetch;
const logger = {
  info: () => Effect.void,
} as unknown as LoggerService;
const layer = Layer.succeed(LoggerServiceTag, logger);
const search = () =>
  Effect.runPromise(
    executeTregSearch({ query: "sensitive query", maxResults: 2 }, "test-token").pipe(
      Effect.provide(layer),
    ),
  );
const found = (title: string, served_by = "tinyfish.web.search") =>
  Response.json({
    output: { results: [{ title, url: "https://example.org/", snippet: "Summary" }] },
    _treg: { served_by },
  });

describe("treg web search", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns free results without a paid call and never puts the token in the URL", async () => {
    const fetchMock = mock(async (_url: URL, _options: RequestInit) =>
      Response.json({ results: [{ title: "Free", url: "https://example.org/" }] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await search();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url.origin + url.pathname).toBe("https://treg.to/call/tinyfish.web.search");
    expect(url.searchParams.get("query")).toBe("sensitive query");
    expect(JSON.stringify(url)).not.toContain("test-token");
    expect((options.headers as Record<string, string>)["X-Treg-Token"]).toBe("test-token");
    expect(options.redirect).toBe("error");
    expect((options.headers as Record<string, string>)["X-Treg-Route-Max-Cost"]).toBeUndefined();
    expect(result.results[0]?.title).toBe("Free");
    expect(result.results[0]?.metadata?.["servedBy"]).toBe("tinyfish.web.search");
  });

  it("routes once after an empty free result and caps cost while excluding TinyFish", async () => {
    const fetchMock = mock(async (_url: unknown, options: RequestInit) =>
      (options.headers as Record<string, string>)["X-Treg-Route-Exclude"]
        ? found("Fallback", "crawl4ai.web.search")
        : Response.json({ results: [] }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await search();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const options = fetchMock.mock.calls[1]![1];
    expect((options.headers as Record<string, string>)["X-Treg-Route-Exclude"]).toBe("tinyfish");
    expect((options.headers as Record<string, string>)["X-Treg-Route-Max-Cost"]).toBe("0.05");
    expect(options.redirect).toBe("error");
    expect(result.results[0]?.title).toBe("Fallback");
  });

  it("routes after free rate limiting or an invalid response", async () => {
    for (const freeResponse of [
      new Response("rate limited", { status: 429 }),
      Response.json({ bad: true }),
    ]) {
      const fetchMock = mock(async (_url: string, _options: RequestInit) =>
        fetchMock.mock.calls.length === 1 ? freeResponse : found("Fallback"),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      expect((await search()).results[0]?.title).toBe("Fallback");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("normalizes provider-native text and publication dates from paid routes", async () => {
    const cases = [
      {
        servedBy: "tavily.web.search",
        row: { content: "Tavily passage", date: "2026-10-15" },
        snippet: "Tavily passage",
        publishedDate: "2026-10-15",
      },
      {
        servedBy: "parallel.web.search",
        row: { excerpts: ["First passage", "Second passage"], publish_date: "2026-10-16" },
        snippet: "First passage\nSecond passage",
        publishedDate: "2026-10-16",
      },
      {
        servedBy: "parallel.web.search",
        row: { excerpts: ["Undated passage"], publish_date: null, content: null, highlights: null },
        snippet: "Undated passage",
        publishedDate: undefined,
      },
      {
        servedBy: "parallel.web.search",
        row: { content: null, excerpts: null, highlights: null, publish_date: null },
        snippet: "",
        publishedDate: undefined,
      },
      {
        servedBy: "exa.web.search",
        row: { highlights: ["Highlighted passage"], publish_date: "unknown" },
        snippet: "Highlighted passage",
        publishedDate: undefined,
      },
      {
        servedBy: "crawl4ai.web.search",
        row: { snippet: "Existing summary", content: "Full passage", excerpts: ["Excerpt"] },
        snippet: "Existing summary",
        publishedDate: undefined,
      },
      {
        servedBy: "parallel.web.search",
        row: { snippet: "  ", content: "", excerpts: ["", "Useful passage", "  "] },
        snippet: "Useful passage",
        publishedDate: undefined,
      },
    ];
    for (const example of cases) {
      const fetchMock = mock(async (_url: unknown, _options: RequestInit) =>
        fetchMock.mock.calls.length === 1
          ? Response.json({ results: [] })
          : Response.json({
              output: {
                results: [{ title: "Source", url: "https://example.org/", ...example.row }],
              },
              _treg: { served_by: example.servedBy },
            }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const result = await search();
      expect(result.results[0]?.snippet).toBe(example.snippet);
      expect(result.results[0]?.publishedDate).toBe(example.publishedDate);
      expect(result.results[0]?.metadata?.["servedBy"]).toBe(example.servedBy);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects malformed provider-native text without exposing the response", async () => {
    for (const row of [
      { content: { secret: "sensitive provider text" } },
      { excerpts: ["sensitive provider text", 42] },
      { highlights: "sensitive provider text" },
    ]) {
      const fetchMock = mock(async (_url: unknown, _options: RequestInit) =>
        fetchMock.mock.calls.length === 1
          ? Response.json({ results: [] })
          : Response.json({ output: { results: [{ url: "https://example.org/", ...row }] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(search()).rejects.toMatchObject({
        message: "treg paid fallback failed or exceeded its cost limit",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("does not retry a failed paid call or leak provider response bodies", async () => {
    const fetchMock = mock(async (_url: string, _options: RequestInit) =>
      fetchMock.mock.calls.length === 1
        ? new Response("rate limited", { status: 429 })
        : new Response("sensitive provider text", { status: 503 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const error = await search().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("paid fallback failed");
    expect((error as Error).message).not.toContain("sensitive provider text");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not follow a redirect with the token on either authenticated request", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({
      port: 0,
      fetch(request) {
        destinationCalls++;
        expect(request.headers.get("X-Treg-Token")).toBeNull();
        return Response.json({ results: [] });
      },
    });
    const redirect = Bun.serve({
      port: 0,
      fetch() {
        return Response.redirect(destination.url, 302);
      },
    });
    try {
      for (const stage of ["free", "routed"] as const) {
        const fetchMock = mock(async (_url: URL | string, options: RequestInit) => {
          const routed = (options.headers as Record<string, string>)["X-Treg-Route-Exclude"];
          if (stage === "routed" && !routed) return Response.json({ results: [] });
          if (stage === "free" && routed) return found("Fallback");
          return originalFetch(redirect.url, options);
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        if (stage === "free") {
          expect((await search()).results[0]?.title).toBe("Fallback");
        } else {
          await expect(search()).rejects.toThrow("paid fallback failed");
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(destinationCalls).toBe(0);
      }
    } finally {
      redirect.stop(true);
      destination.stop(true);
    }
  });
});
