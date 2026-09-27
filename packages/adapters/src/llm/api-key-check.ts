/**
 * A cheap check that a provider accepts an API key, made right after the key
 * is pasted.
 *
 * A wrong key otherwise surfaces much later, as a 401 in the middle of the
 * first conversation. Most providers expose an authenticated model listing
 * that costs nothing, so `checkApiKey` calls it once with a short timeout.
 * A 401 rejects the key; a 403 can mean a restricted key cannot list models,
 * even though inference is allowed, and is reported separately for a warning.
 * A provider with no such endpoint here, a
 * custom base URL, a network failure or any other status is `unchecked`: the
 * key is saved as typed and the first real request decides.
 */

import { llmFetch } from "./llm-fetch";

/** What the provider said about a key. */
export type ApiKeyCheck = "accepted" | "rejected" | "permission-denied" | "unchecked";

/** Long enough for a slow link, short enough that saving a key never feels stuck. */
export const API_KEY_CHECK_TIMEOUT_MS = 10_000;

interface KeyCheckRequest {
  readonly url: string;
  readonly headers: (apiKey: string) => Record<string, string>;
}

const bearer = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
});

/** Authenticated, free endpoints; access here does not imply inference permission. */
const KEY_CHECKS: Readonly<Record<string, KeyCheckRequest>> = {
  openai: { url: "https://api.openai.com/v1/models", headers: bearer },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (apiKey) => ({ "x-goog-api-key": apiKey }),
  },
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: bearer },
  xai: { url: "https://api.x.ai/v1/models", headers: bearer },
  cerebras: { url: "https://api.cerebras.ai/v1/models", headers: bearer },
  deepseek: { url: "https://api.deepseek.com/models", headers: bearer },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/models", headers: bearer },
  groq: { url: "https://api.groq.com/openai/v1/models", headers: bearer },
  mistral: { url: "https://api.mistral.ai/v1/models", headers: bearer },
  togetherai: { url: "https://api.together.xyz/v1/models", headers: bearer },
};

/**
 * Ask the provider whether it accepts the key.
 *
 * @param provider - Provider id, e.g. "openai".
 * @param apiKey - The key as it will be saved.
 * @param fetchImpl - Injectable for tests.
 */
export async function checkApiKey(
  provider: string,
  apiKey: string,
  fetchImpl: typeof fetch = llmFetch,
): Promise<ApiKeyCheck> {
  const check = KEY_CHECKS[provider];
  if (check === undefined) {
    return "unchecked";
  }
  try {
    const response = await fetchImpl(check.url, {
      method: "GET",
      headers: check.headers(apiKey),
      signal: AbortSignal.timeout(API_KEY_CHECK_TIMEOUT_MS),
    });
    if (response.ok) {
      return "accepted";
    }
    if (response.status === 401) return "rejected";
    if (response.status === 403) return "permission-denied";
    return "unchecked";
  } catch {
    return "unchecked";
  }
}
