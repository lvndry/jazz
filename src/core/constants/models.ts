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
export const STATIC_PROVIDER_MODELS = {
  openai: [
    { id: "gpt-5.1", displayName: "GPT-5.1", isReasoningModel: true },
    { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isReasoningModel: true },
    { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true },
    { id: "gpt-5-pro", displayName: "GPT-5 Pro", isReasoningModel: true },
    { id: "gpt-5-codex", displayName: "GPT-5 Codex", isReasoningModel: true },
    { id: "gpt-5-mini", displayName: "GPT-5 Mini", isReasoningModel: true },
    { id: "gpt-5-nano", displayName: "GPT-5 Nano", isReasoningModel: true },
    { id: "gpt-4.1", displayName: "GPT-4.1", isReasoningModel: true },
    { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", isReasoningModel: true },
    { id: "gpt-4.1-nano", displayName: "GPT-4.1 Nano", isReasoningModel: true },
    { id: "gpt-4o", displayName: "GPT-4o", isReasoningModel: false },
    { id: "gpt-4o-mini", displayName: "GPT-4o Mini", isReasoningModel: false },
    { id: "o4-mini", displayName: "o4-mini", isReasoningModel: true },
  ],
  anthropic: [
    { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isReasoningModel: true },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isReasoningModel: true },
    { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", isReasoningModel: true },
  ],
  google: [
    { id: "gemini-3-pro-preview", displayName: "Gemini 3 Pro (Preview)", isReasoningModel: true },
    { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", isReasoningModel: true },
    { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", isReasoningModel: true },
    {
      id: "gemini-2.5-flash-lite",
      displayName: "Gemini 2.5 Flash Lite",
      isReasoningModel: true,
    },
    { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", isReasoningModel: false },
  ],
  mistral: [
    { id: "mistral-large-latest", displayName: "Mistral Large", isReasoningModel: false },
    { id: "mistral-medium-latest", displayName: "Mistral Medium", isReasoningModel: false },
    { id: "mistral-small-latest", displayName: "Mistral Small", isReasoningModel: false },
    { id: "ministral-14b-latest", displayName: "Mistral 3 14B", isReasoningModel: false },
    { id: "ministral-8b-latest", displayName: "Mistral 3 8B", isReasoningModel: false },
    { id: "ministral-3b-latest", displayName: "Mistral 3 3B", isReasoningModel: false },
    { id: "magistral-medium-2506", displayName: "Magistral Medium", isReasoningModel: true },
    { id: "magistral-small-2506", displayName: "Magistral Small", isReasoningModel: true },
  ],
  xai: [
    {
      id: "grok-4-fast-non-reasoning",
      displayName: "Grok 4 Fast (Non-Reasoning)",
      isReasoningModel: false,
    },
    {
      id: "grok-4-fast-reasoning",
      displayName: "Grok 4 Fast (Reasoning)",
      isReasoningModel: true,
    },
    { id: "grok-4", displayName: "Grok 4", isReasoningModel: false },
    { id: "grok-code-fast-1", displayName: "Grok 4 (0709)", isReasoningModel: true },
    { id: "grok-3", displayName: "Grok 3", isReasoningModel: true },
    { id: "grok-3-mini", displayName: "Grok 3 Mini", isReasoningModel: true },
  ],
  deepseek: [{ id: "deepseek-chat", displayName: "DeepSeek Chat", isReasoningModel: false }],
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
