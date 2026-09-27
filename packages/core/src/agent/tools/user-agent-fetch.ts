import { HTTP_USER_AGENT, WEB_FETCH_USER_AGENT } from "@/core/constants/agent";
import { type EgressPolicy, type GuardedResponse, guardedFetch } from "./guarded-fetch";

// A browser User-Agent gets more sites to serve their real content, but a few reject it outright
// (401/403) or throttle it (429) as suspected scraping. When that happens, retry once as the
// honest Jazz client, which those hosts tend to allow. Any other status is the origin's own
// answer and is returned unchanged for the caller to handle.
const USER_AGENT_BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * GET a model-chosen URL as a browser through `guardedFetch`, falling back to the honest Jazz
 * User-Agent when the browser one is refused. Redirects are followed hop by hop under the
 * destination policy. `accept` sets the Accept header for both attempts.
 */
export async function fetchWithUserAgentFallback(
  url: string,
  init: { signal?: AbortSignal; accept?: string; policy?: EgressPolicy } = {},
): Promise<GuardedResponse> {
  const baseHeaders: Record<string, string> = {};
  if (init.accept !== undefined) {
    baseHeaders["Accept"] = init.accept;
  }

  const request = {
    ...(init.policy ?? {}),
    ...(init.signal ? { signal: init.signal } : {}),
  };
  const browserAttempt = await guardedFetch(url, {
    ...request,
    headers: { ...baseHeaders, "User-Agent": WEB_FETCH_USER_AGENT },
  });
  if (!USER_AGENT_BLOCKED_STATUSES.has(browserAttempt.response.status)) {
    return browserAttempt;
  }

  // The browser attempt is discarded; release its body so the connection can be reused.
  await browserAttempt.response.body?.cancel().catch(() => {});
  return guardedFetch(url, {
    ...request,
    headers: { ...baseHeaders, "User-Agent": HTTP_USER_AGENT },
  });
}
