import type { ProviderName } from "@/core/constants/models";
import type { LLMConfig } from "@/core/types/config";

/**
 * Lay an agent's per-provider base URL overrides over the global LLM config, so every consumer
 * that resolves a local server's address through `llm.<provider>.base_url` sees the agent's.
 */
export function withAgentBaseUrls(
  llmConfig: LLMConfig | undefined,
  baseUrls: Partial<Record<ProviderName, string>> | undefined,
): LLMConfig | undefined {
  if (!baseUrls) return llmConfig;

  const merged: Record<string, unknown> = { ...(llmConfig ?? {}) };
  for (const [provider, baseUrl] of Object.entries(baseUrls)) {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) continue;
    const existing = merged[provider];
    merged[provider] = {
      ...(existing && typeof existing === "object" ? existing : {}),
      base_url: baseUrl,
    };
  }
  return merged;
}
