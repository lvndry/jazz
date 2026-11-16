import { Effect } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderName } from "@/core/types/config";

/** One provider in the fallback chain, with the key it will be called with. */
export interface WebSearchChainLink {
  readonly provider: WebSearchProviderName;
  readonly apiKey: string;
}

/**
 * Where an agent's searches go.
 *
 * - `external`: Jazz's own `web_search` tool, trying `chain` in order until one provider answers.
 * - `builtin`: no external provider applies, so the model provider's native search is used when
 *   it hosts one.
 *
 * `missingKeys` lists providers named in an explicit order that have no key.
 */
export type WebSearchRoute =
  | {
      readonly kind: "external";
      readonly chain: readonly WebSearchChainLink[];
      readonly missingKeys: readonly WebSearchProviderName[];
    }
  | {
      readonly kind: "builtin";
      readonly missingKeys: readonly WebSearchProviderName[];
    };

/**
 * Resolve the provider chain for one agent.
 *
 * An explicit list is authoritative: a provider left off it is never called, even with a key, and
 * an explicit empty list selects the model's built-in search. With no list anywhere, every
 * provider holding a key joins the chain in {@link WEB_SEARCH_PROVIDERS} order.
 */
export function resolveWebSearchRoute(
  config: AgentConfigService,
  agentProviders: readonly WebSearchProviderName[] | undefined,
): Effect.Effect<WebSearchRoute, never> {
  return Effect.gen(function* () {
    const appConfig = yield* config.appConfig;
    const explicit = agentProviders ?? appConfig.web_search?.providers;
    const chain: WebSearchChainLink[] = [];
    const missingKeys: WebSearchProviderName[] = [];
    for (const provider of new Set(explicit ?? WEB_SEARCH_PROVIDERS)) {
      const apiKey = yield* config.getOrElse(`web_search.${provider}.api_key`, "");
      if (apiKey === "") {
        if (explicit !== undefined) {
          missingKeys.push(provider);
        }
        continue;
      }
      chain.push({ provider, apiKey });
    }

    if (chain.length === 0) {
      return { kind: "builtin", missingKeys } as const;
    }
    return { kind: "external", chain, missingKeys } as const;
  });
}

/**
 * Why a provider call failed, as far as choosing what to do next is concerned.
 *
 * - `quota`: plan or credit limit reached; it will keep failing for a long time.
 * - `rate_limited`: too many requests right now; it recovers within about a minute.
 * - `auth`: the key was refused; it keeps failing until someone changes the key.
 * - `other`: anything else, including bad requests another provider may accept.
 */
export type SearchFailureKind = "quota" | "rate_limited" | "auth" | "other";

/**
 * 402 Payment Required is how Exa and treg report exhausted credit; Tavily reports its plan and
 * pay-as-you-go limits as 432 and 433.
 */
const QUOTA_FAILURE =
  /\b(402|432|433)\b|payment required|quota|usage limit|plan limit|credit|insufficient (funds|balance)/i;
const RATE_LIMIT_FAILURE = /\b429\b|too many requests|rate.?limit/i;
/** Brave reports a refused key as 422 with `SUBSCRIPTION_TOKEN_INVALID` in the body. */
const AUTH_FAILURE =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _]api[ _]key|token[ _](is[ _])?invalid/i;

export function classifySearchFailure(message: string): SearchFailureKind {
  if (QUOTA_FAILURE.test(message)) {
    return "quota";
  }
  if (RATE_LIMIT_FAILURE.test(message)) {
    return "rate_limited";
  }
  if (AUTH_FAILURE.test(message)) {
    return "auth";
  }
  return "other";
}

/** How long a provider moves to the back of the chain after each kind of failure. */
const COOLDOWN_MS: Record<SearchFailureKind, number> = {
  quota: 60 * 60_000,
  rate_limited: 60_000,
  auth: 60 * 60_000,
  other: 0,
};

/**
 * Providers that recently failed in a way that will repeat, remembered for this process so a long
 * chat, the daemon or a bot does not spend every search re-discovering an exhausted quota.
 *
 * A cooling provider is demoted to the end of the chain, never dropped: if every healthy provider
 * also fails, it still gets tried.
 */
export class WebSearchCooldowns {
  private readonly until = new Map<WebSearchProviderName, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(provider: WebSearchProviderName, kind: SearchFailureKind): number {
    const duration = COOLDOWN_MS[kind];
    if (duration > 0) {
      this.until.set(provider, this.now() + duration);
    }
    return duration;
  }

  clear(provider: WebSearchProviderName): void {
    this.until.delete(provider);
  }

  isCooling(provider: WebSearchProviderName): boolean {
    const until = this.until.get(provider);
    if (until === undefined) {
      return false;
    }
    if (until <= this.now()) {
      this.until.delete(provider);
      return false;
    }
    return true;
  }

  /** The chain in try order: healthy providers first, cooling ones after, each in chain order. */
  order<Link extends WebSearchChainLink>(chain: readonly Link[]): readonly Link[] {
    const healthy = chain.filter((link) => !this.isCooling(link.provider));
    const cooling = chain.filter((link) => this.isCooling(link.provider));
    return [...healthy, ...cooling];
  }
}

export const processWebSearchCooldowns = new WebSearchCooldowns();
