import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";

/**
 * Parse a "provider/model" string into its parts.
 *
 * Splits on the first "/" so slash-bearing model ids (e.g. OpenRouter's
 * "openrouter/anthropic/claude-3.5") keep their full model segment. Each
 * segment is trimmed so values like "openai / gpt-4" normalize cleanly.
 * Returns null when the shape is malformed or the provider is not a known
 * provider.
 */
export function parseProviderModel(
  value: string,
): { provider: ProviderName; model: string } | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  if (!(AVAILABLE_PROVIDERS as readonly string[]).includes(provider)) {
    return null;
  }
  return { provider: provider as ProviderName, model };
}
