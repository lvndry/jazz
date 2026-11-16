import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { AgentConfigService } from "../../interfaces/agent-config";
import { partialFake } from "../../test-support/fakes";
import type { AppConfig } from "../../types";
import {
  classifySearchFailure,
  resolveWebSearchRoute,
  WebSearchCooldowns,
} from "./web-search-route";

function configWith(
  webSearch: AppConfig["web_search"],
  keys: Record<string, string>,
): AgentConfigService {
  return partialFake<AgentConfigService>({
    appConfig: Effect.succeed({
      storage: { type: "file", path: "./.jazz" },
      logging: { level: "info", format: "plain" },
      ...(webSearch === undefined ? {} : { web_search: webSearch }),
    }),
    getOrElse: <A>(key: string, fallback: A) => {
      const provider = key.split(".")[1] ?? "";
      return Effect.succeed((keys[provider] as A | undefined) ?? fallback);
    },
  });
}

describe("resolveWebSearchRoute", () => {
  it("chains every keyed provider in canonical order when no order is set", async () => {
    const route = await Effect.runPromise(
      resolveWebSearchRoute(configWith(undefined, { brave: "b", exa: "e" }), undefined),
    );
    expect(route).toEqual({
      kind: "external",
      chain: [
        { provider: "exa", apiKey: "e" },
        { provider: "brave", apiKey: "b" },
      ],
      missingKeys: [],
    });
  });

  it("lets the agent's order replace the global one and reports keyless entries", async () => {
    const route = await Effect.runPromise(
      resolveWebSearchRoute(configWith({ providers: ["exa"] }, { brave: "b", exa: "e" }), [
        "tavily",
        "brave",
      ]),
    );
    expect(route).toEqual({
      kind: "external",
      chain: [{ provider: "brave", apiKey: "b" }],
      missingKeys: ["tavily"],
    });
  });

  it("selects built-in search for an empty order even with keys", async () => {
    const route = await Effect.runPromise(
      resolveWebSearchRoute(configWith({ providers: [] }, { exa: "e" }), undefined),
    );
    expect(route.kind).toBe("builtin");
  });
});

describe("classifySearchFailure", () => {
  it.each([
    ["Exa search failed: 402 Payment Required", "quota"],
    ["Tavily search failed: 432 ", "quota"],
    ["You exceeded your current quota", "quota"],
    ["Brave search failed: 429 Too Many Requests", "rate_limited"],
    ["rate limit exceeded", "rate_limited"],
    ["Perplexity search failed: 401 Unauthorized", "auth"],
    ["Invalid API key", "auth"],
    ['Brave search failed: 422 {"error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}', "auth"],
    ["treg paid fallback failed or exceeded its cost limit (HTTP 402)", "quota"],
    ["Brave search failed: 503 Service Unavailable", "other"],
    ["The operation timed out.", "other"],
  ])("%s → %s", (message, kind) => {
    expect(classifySearchFailure(message)).toBe(kind as ReturnType<typeof classifySearchFailure>);
  });
});

describe("WebSearchCooldowns", () => {
  it("demotes a cooling provider and restores it once the cooldown ends", () => {
    let now = 0;
    const cooldowns = new WebSearchCooldowns(() => now);
    const chain = [
      { provider: "exa" as const, apiKey: "e" },
      { provider: "brave" as const, apiKey: "b" },
    ];

    cooldowns.record("exa", "rate_limited");
    expect(cooldowns.order(chain).map((link) => link.provider)).toEqual(["brave", "exa"]);

    now = 60_001;
    expect(cooldowns.order(chain).map((link) => link.provider)).toEqual(["exa", "brave"]);
  });

  it("does not cool a provider for a failure another attempt may not repeat", () => {
    const cooldowns = new WebSearchCooldowns();
    expect(cooldowns.record("exa", "other")).toBe(0);
    expect(cooldowns.isCooling("exa")).toBe(false);
  });
});
