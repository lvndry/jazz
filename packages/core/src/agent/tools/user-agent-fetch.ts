import { HTTP_USER_AGENT, WEB_FETCH_USER_AGENT } from "@/core/constants/agent";

// A browser User-Agent gets more sites to serve their real content, but a few reject it outright
// (401/403) or throttle it (429) as suspected scraping. When that happens, retry once as the
// honest Jazz client, which those hosts tend to allow. Any other status is the origin's own
// answer and is returned unchanged for the caller to handle.
const USER_AGENT_BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * Fetch a URL as a browser, falling back to the honest Jazz User-Agent when the browser one is
 * refused. Follows redirects. `accept` sets the Accept header for both attempts.
 */
export async function fetchWithUserAgentFallback(
  url: string,
  init: { signal?: AbortSignal; accept?: string } = {},
): Promise<Response> {
  const baseHeaders: Record<string, string> = {};
  if (init.accept !== undefined) baseHeaders["Accept"] = init.accept;

  const signal = init.signal ?? null;
  const browserResponse = await fetch(url, {
    headers: { ...baseHeaders, "User-Agent": WEB_FETCH_USER_AGENT },
    redirect: "follow",
    signal,
  });
  if (!USER_AGENT_BLOCKED_STATUSES.has(browserResponse.status)) return browserResponse;

  // The browser attempt is discarded; release its body so the connection can be reused.
  await browserResponse.body?.cancel().catch(() => {});
  return fetch(url, {
    headers: { ...baseHeaders, "User-Agent": HTTP_USER_AGENT },
    redirect: "follow",
    signal,
  });
}
