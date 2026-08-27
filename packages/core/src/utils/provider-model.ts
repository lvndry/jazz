/**
 * Parses and formats "provider/model" strings, and maps provider ids to
 * their official brand display names.
 */
import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ai_gateway: "Vercel AI Gateway",
  alibaba: "Alibaba",
  anthropic: "Anthropic",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  gemini: "Gemini",
  groq: "Groq",
  llamacpp: "llama.cpp",
  minimax: "MiniMax",
  mistral: "Mistral",
  moonshotai: "Moonshot AI",
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  togetherai: "Together AI",
  xai: "xAI",
  zhipuai: "Z.ai",
};

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

/**
 * Combine a provider and model id into the canonical "provider/model" string.
 */
export function formatProviderModel(provider: string, model: string): `${string}/${string}` {
  return `${provider}/${model}`;
}

/**
 * The canonical "provider/model" string for an agent, derived from its config.
 */
export function agentModelString(config: {
  readonly llmProvider: string;
  readonly llmModel: string;
}): `${string}/${string}` {
  return formatProviderModel(config.llmProvider, config.llmModel);
}

/**
 * Format a provider identifier with its official brand casing.
 *
 * Unknown providers fall back to title-cased words separated by underscores.
 */
export function formatProviderDisplayName(provider: string): string {
  const known = PROVIDER_DISPLAY_NAMES[provider];
  if (known) return known;
  return provider.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
