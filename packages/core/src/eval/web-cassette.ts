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

// Hosts the cassette must NEVER intercept: the LLM provider APIs (the model
// call itself), model-metadata, and local model servers. Only genuine web-tool
// traffic is recorded/replayed — otherwise replay mode would starve the LLM.
const BYPASS_HOST_SUBSTRINGS = [
  "openai.com",
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
  "moonshot",
  "minimax",
  "cerebras",
  "dashscope",
  "models.dev",
  "localhost",
  "127.0.0.1",
];

export function isBypassHost(
  input: RequestInfo | URL,
  modelServerHosts: readonly string[] = [],
): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    modelServerHosts.includes(host) ||
    BYPASS_HOST_SUBSTRINGS.some((needle) => host.includes(needle))
  );
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Hosts of the user-run model servers Jazz may call: each local provider's base URL from
 * `<jazzHome>/config.json` and from its environment variable. A server can live at any
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
    const fromEnvironment = environment[LOCAL_SERVER_PROVIDERS[provider].envVar];
    return [typeof configured === "string" ? configured : undefined, fromEnvironment];
  });
  return [
    ...new Set(
      urls
        .filter((url): url is string => url !== undefined && url.trim().length > 0)
        .map((url) => hostnameOf(url.trim()))
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
    if (isBypassHost(input, modelServerHosts)) return realFetch(input, init);
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
