import { afterEach, describe, expect, it } from "bun:test";
import { HTTP_USER_AGENT, WEB_FETCH_USER_AGENT } from "@/core/constants/agent";
import { fetchWithUserAgentFallback } from "./user-agent-fetch";

const originalFetch = globalThis.fetch;

interface Call {
  readonly url: string;
  readonly userAgent: string | undefined;
  readonly accept: string | undefined;
}

/** Record each fetch call's UA/Accept and reply with the scripted statuses in order. */
function scriptFetch(statuses: readonly number[]): { calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, userAgent: headers["User-Agent"], accept: headers["Accept"] });
    const status = statuses[index++] ?? 200;
    return { ok: status < 400, status, body: null } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

describe("fetchWithUserAgentFallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses the browser User-Agent and does not retry on success", async () => {
    const { calls } = scriptFetch([200]);
    const response = await fetchWithUserAgentFallback("https://example.com/x");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userAgent).toBe(WEB_FETCH_USER_AGENT);
  });

  it("retries once with the honest User-Agent when the browser one is blocked", async () => {
    const { calls } = scriptFetch([403, 200]);
    const response = await fetchWithUserAgentFallback("https://example.com/x", {
      accept: "application/pdf,*/*",
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.userAgent).toBe(WEB_FETCH_USER_AGENT);
    expect(calls[1]?.userAgent).toBe(HTTP_USER_AGENT);
    // The Accept header carries across both attempts.
    expect(calls[1]?.accept).toBe("application/pdf,*/*");
  });

  it("does not retry on a non-UA status such as 404", async () => {
    const { calls } = scriptFetch([404]);
    const response = await fetchWithUserAgentFallback("https://example.com/missing");
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});
