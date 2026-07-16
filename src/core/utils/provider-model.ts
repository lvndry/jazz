import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";

/**
 * Parse a "provider/model" string into its parts.
 *
 * Splits on the first "/" so slash-bearing model ids (e.g. OpenRouter's
 * "openrouter/anthropic/claude-3.5") keep their full model segment. Returns
 * null when the shape is malformed or the provider is not a known provider.
 */
export function parseProviderModel(
  value: string,
): { provider: ProviderName; model: string } | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex);
  const model = trimmed.slice(slashIndex + 1);
  if (!(AVAILABLE_PROVIDERS as readonly string[]).includes(provider)) {
    return null;
  }
  return { provider: provider as ProviderName, model };
}
