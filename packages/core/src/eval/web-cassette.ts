/**
 * Records/replays `fetch` calls to a JSON cassette for deterministic evals,
 * bypassing LLM provider hosts so replay never starves the model itself.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_MODEL_PROVIDERS, LOCAL_SERVER_PROVIDERS } from "@/core/constants/local-providers";

interface CassetteEntry {
  status: number;
  body: string;
  headers: Record<string, string>;
}
type Cassette = Record<string, CassetteEntry>;

export function requestKey(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  let body = "";
  if (typeof init?.body === "string") body = init.body;
  else if (init?.body instanceof URLSearchParams) body = init.body.toString();
  return `${method} ${url} ${body}`;
}

/**
 * Domains the cassette never intercepts: the LLM provider APIs (the model call itself) and
 * model metadata. A host matches when it is one of these or a subdomain of one, so a web
 * page whose name merely contains a provider's name is still recorded. Local model servers
 * are not listed here; they pass only at their exact `host:port`.
 */
const PROVIDER_DOMAINS = [
  "openai.com",
  "chatgpt.com",
  "openrouter.ai",
  "anthropic.com",
  "googleapis.com",
  "mistral.ai",
  "groq.com",
  "x.ai",
  "together.xyz",
  "together.ai",
  "cohere.com",
  "fireworks.ai",
  "deepseek.com",
  "moonshot.ai",
  "minimax.io",
  "cerebras.ai",
  "aliyuncs.com",
  "nvidia.com",
  "ollama.com",
  "models.dev",
];

function isProviderDomain(hostname: string): boolean {
  return PROVIDER_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function isBypassHost(
  input: RequestInfo | URL,
  modelServerHosts: readonly string[] = [],
): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return modelServerHosts.includes(parsed.host) || isProviderDomain(parsed.hostname);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`).host;
  } catch {
    return undefined;
  }
}

/**
 * `host:port` of the user-run model servers Jazz may call, so a web tool's request to another
 * port on the same machine is still recorded: each local provider's base URL from
 * `<jazzHome>/config.json`, from its environment variable, and its default address. A server can live at any
 * address, such as another machine on a private network, which no fixed host list covers,
 * and replaying the model call would starve the run.
 */
export function localModelServerHosts(
  jazzHome: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  let llm: Record<string, { base_url?: unknown } | undefined> = {};
  try {
    const config = JSON.parse(readFileSync(join(jazzHome, "config.json"), "utf-8")) as {
      llm?: typeof llm;
    };
    llm = config.llm ?? {};
  } catch {
    llm = {};
  }
  const urls = LOCAL_MODEL_PROVIDERS.flatMap((provider) => {
    const configured = llm[provider]?.base_url;
    const server = LOCAL_SERVER_PROVIDERS[provider];
    return [
      typeof configured === "string" ? configured : undefined,
      environment[server.envVar],
      server.defaultUrl,
    ];
  });
  return [
    ...new Set(
      urls
        .filter((url): url is string => url !== undefined && url.trim().length > 0)
        .map((url) => hostOf(url.trim()))
        .filter((host): host is string => host !== undefined),
    ),
  ];
}

/**
 * Monkeypatch globalThis.fetch for deterministic evals. Inert unless installed.
 * replay: serve only recorded requests; throw on a miss (never silently hit the
 * network, or a run would be non-reproducible). record: pass through, then store.
 */
export function installWebCassette(
  cassettePath: string,
  mode: "record" | "replay",
  modelServerHosts: readonly string[] = [],
): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const cassette: Cassette = existsSync(cassettePath)
    ? (JSON.parse(readFileSync(cassettePath, "utf-8")) as Cassette)
    : {};

  // Bun's `typeof fetch` demands a `preconnect` member the cassette never needs.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isBypassHost(input, modelServerHosts)) {
      return realFetch(input, init);
    }
    const key = requestKey(input, init);
    if (mode === "replay") {
      const entry = cassette[key];
      if (!entry) throw new Error(`web-cassette replay miss: ${key}`);
      return new Response(entry.body, { status: entry.status, headers: entry.headers });
    }
    const res = await realFetch(input, init);
    const body = await res.clone().text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, headerName) => (headers[headerName] = value));
    cassette[key] = { status: res.status, body, headers };
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2));
    return res;
  }) as typeof fetch;
}
