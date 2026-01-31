import type { ModelInfo } from "../types";

/**
 * Static model definitions for each provider
 *
 * These are domain constants representing what models exist and their properties.
 * Infrastructure concerns (API endpoints, base URLs) are handled in the services layer.
 *
 * The provider names are defined here as the source of truth, and the ProviderName type
 * is derived from this constant to ensure they stay in sync.
 */
/**
 * Default context window size for models without explicit specification.
 * 128k is a reasonable default as it's the most common context window size.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

export const STATIC_PROVIDER_MODELS = {
  openai: [
    // GPT-5 series - no official specs yet, using 1M based on GPT-4.1 pattern
    { id: "gpt-5.2-pro", displayName: "GPT-5.2 Pro", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5.2", displayName: "GPT-5.2", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5.1", displayName: "GPT-5.1", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Codex Mini", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5-pro", displayName: "GPT-5 Pro", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5-mini", displayName: "GPT-5 Mini", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5-nano", displayName: "GPT-5 Nano", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-5-codex", displayName: "GPT-5 Codex", isReasoningModel: true, supportsTools: true, contextWindow: 1000000 },
    // GPT-4.1 series - verified 1M context window (April 2025)
    { id: "gpt-4.1", displayName: "GPT-4.1", isReasoningModel: false, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", isReasoningModel: false, supportsTools: true, contextWindow: 1000000 },
    { id: "gpt-4.1-nano", displayName: "GPT-4.1 Nano", isReasoningModel: false, supportsTools: true, contextWindow: 1000000 },
    // GPT-4o series - verified 128k context window
    { id: "gpt-4o", displayName: "GPT-4o", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "gpt-4o-mini", displayName: "GPT-4o Mini", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
  ],
  anthropic: [
    // Claude 4.5 series - verified 200k context window (official docs)
    { id: "claude-opus-4-5", displayName: "Claude Opus 4.5", isReasoningModel: true, supportsTools: true, contextWindow: 200000 },
    { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isReasoningModel: true, supportsTools: true, contextWindow: 200000 },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isReasoningModel: true, supportsTools: true, contextWindow: 200000 },
    { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", isReasoningModel: true, supportsTools: true, contextWindow: 200000 },
  ],
  google: [
    // Gemini series - verified ~1M context window (1,048,576 tokens)
    { id: "gemini-3-pro-preview", displayName: "Gemini 3 Pro", isReasoningModel: true, supportsTools: true, contextWindow: 1048576 },
    { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash", isReasoningModel: true, supportsTools: true, contextWindow: 1048576 },
    { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", isReasoningModel: true, supportsTools: true, contextWindow: 1048576 },
    { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", isReasoningModel: true, supportsTools: true, contextWindow: 1048576 },
    { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite", isReasoningModel: true, supportsTools: true, contextWindow: 1048576 },
    { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", isReasoningModel: false, supportsTools: true, contextWindow: 1048576 },
  ],
  mistral: [
    // Mistral general models - verified 128k context window
    { id: "mistral-large-latest", displayName: "Mistral Large", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "mistral-medium-latest", displayName: "Mistral Medium", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "mistral-small-latest", displayName: "Mistral Small", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "ministral-14b-latest", displayName: "Ministral 14B", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "ministral-8b-latest", displayName: "Ministral 8B", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    { id: "ministral-3b-latest", displayName: "Ministral 3B", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
    // Magistral reasoning models - verified 40k context window (optimized for step-by-step logic)
    { id: "magistral-medium-latest", displayName: "Magistral Medium", isReasoningModel: true, supportsTools: true, contextWindow: 40000 },
    { id: "magistral-small-latest", displayName: "Magistral Small", isReasoningModel: true, supportsTools: true, contextWindow: 40000 },
  ],
  xai: [
    // Grok 4 series - verified 256k context window
    { id: "grok-4-fast-non-reasoning", displayName: "Grok 4 Fast (Non-Reasoning)", isReasoningModel: false, supportsTools: true, contextWindow: 256000 },
    { id: "grok-4-fast-reasoning", displayName: "Grok 4 Fast (Reasoning)", isReasoningModel: true, supportsTools: true, contextWindow: 256000 },
    { id: "grok-4", displayName: "Grok 4", isReasoningModel: false, supportsTools: true, contextWindow: 256000 },
    { id: "grok-code-fast-1", displayName: "Grok 4 (0709)", isReasoningModel: true, supportsTools: true, contextWindow: 256000 },
    // Grok 3 series - verified 131,072 context window
    { id: "grok-3", displayName: "Grok 3", isReasoningModel: true, supportsTools: true, contextWindow: 131072 },
    { id: "grok-3-mini", displayName: "Grok 3 Mini", isReasoningModel: true, supportsTools: true, contextWindow: 131072 },
  ],
  deepseek: [
    // DeepSeek Chat V3 - verified 128k context window
    { id: "deepseek-chat", displayName: "DeepSeek Chat", isReasoningModel: false, supportsTools: true, contextWindow: 128000 },
  ],
  ollama: [],
  openrouter: [],
  ai_gateway: [],
  groq: [],
} as const satisfies Record<string, readonly ModelInfo[]>;

export type ProviderName = keyof typeof STATIC_PROVIDER_MODELS;

/**
 * List of all available providers
 */
export const AVAILABLE_PROVIDERS = Object.keys(STATIC_PROVIDER_MODELS) as ProviderName[];
