import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface CassetteEntry {
  status: number;
  body: string;
  headers: Record<string, string>;
}
type Cassette = Record<string, CassetteEntry>;

export function requestKey(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  return `${method} ${url} ${body}`;
}

/**
 * Monkeypatch globalThis.fetch for deterministic evals. Inert unless installed.
 * replay: serve only recorded requests; throw on a miss (never silently hit the
 * network, or a run would be non-reproducible). record: pass through, then store.
 */
export function installWebCassette(cassettePath: string, mode: "record" | "replay"): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const cassette: Cassette = existsSync(cassettePath)
    ? (JSON.parse(readFileSync(cassettePath, "utf-8")) as Cassette)
    : {};

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
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
  };
}
