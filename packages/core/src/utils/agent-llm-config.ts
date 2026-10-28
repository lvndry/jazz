/**
 * @fileoverview Per-agent provider overrides laid over the global LLM config.
 *
 * An agent can point a provider at its own server (`llm.baseUrls`) and authenticate with its own
 * key (`llm.apiKeys`); a named companion does both. Requests receive these overrides directly,
 * but code that reads `llm.<provider>.base_url` or `.api_key` from the config — the run-start
 * lookup of what a local server is serving, the summarizer — needs them merged in, or it asks
 * the global server with the global key and silently describes the wrong model.
 */

import type { ProviderName } from "@/core/constants/models";
import type { LLMConfig } from "@/core/types/config";

/** An agent's per-provider connection overrides, as `config.llm` holds them. */
export interface AgentProviderOverrides {
  readonly baseUrls?: Partial<Record<ProviderName, string>> | undefined;
  readonly apiKeys?: Partial<Record<ProviderName, string>> | undefined;
}

/**
 * Lay an agent's per-provider base URL and API key overrides over the global LLM config. Empty
 * overrides are ignored; the global config is never mutated, and is returned as-is when the
 * agent overrides nothing.
 */
export function withAgentProviderOverrides(
  llmConfig: LLMConfig | undefined,
  overrides: AgentProviderOverrides,
): LLMConfig | undefined {
  const fields = [
    ["base_url", overrides.baseUrls],
    ["api_key", overrides.apiKeys],
  ] as const;
  if (fields.every(([, byProvider]) => byProvider === undefined)) return llmConfig;

  const merged: Record<string, unknown> = { ...(llmConfig ?? {}) };
  for (const [field, byProvider] of fields) {
    for (const [provider, value] of Object.entries(byProvider ?? {})) {
      if (typeof value !== "string" || value.length === 0) continue;
      const existing = merged[provider];
      merged[provider] = {
        ...(existing && typeof existing === "object" ? existing : {}),
        [field]: value,
      };
    }
  }
  return merged;
}
