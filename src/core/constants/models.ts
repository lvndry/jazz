/**
 * Static model definitions for each provider
 *
 * Model IDs and display names only; metadata (context window, tool support, reasoning)
 * is fetched from https://models.dev/api.json at runtime (lazy load, cached 1h).
 *
 * To add a new model: just add the ID (and optional displayName). The rest comes from models.dev.
 *
 * Efficiency: models.dev (~1MB JSON) is fetched once on first provider load, then cached
 * in memory for 1 hour. All model metadata lookups are O(1) from an indexed map.
 *
 * The provider names are defined here as the source of truth, and the ProviderName type
 * is derived from this constant to ensure they stay in sync.
 */

/**
 * Default context window size for models without explicit specification.
 * 128k is a reasonable default as it's the most common context window size.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface StaticModelEntry {
  readonly id: string;
  readonly displayName?: string;
}

export const STATIC_PROVIDER_MODELS = {
  openai: [
    { id: "gpt-5.2-pro", displayName: "GPT-5.2 Pro" },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
    { id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex" },
    { id: "gpt-5.1", displayName: "GPT-5.1" },
    { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex" },
    { id: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Codex Mini" },
    { id: "gpt-5-pro", displayName: "GPT-5 Pro" },
    { id: "gpt-5", displayName: "GPT-5" },
    { id: "gpt-5-mini", displayName: "GPT-5 Mini" },
    { id: "gpt-5-nano", displayName: "GPT-5 Nano" },
    { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
    { id: "gpt-4.1", displayName: "GPT-4.1" },
    { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini" },
    { id: "gpt-4.1-nano", displayName: "GPT-4.1 Nano" },
    { id: "gpt-4o", displayName: "GPT-4o" },
    { id: "gpt-4o-mini", displayName: "GPT-4o Mini" },
  ],
  anthropic: [
    { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
    { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    { id: "claude-opus-4-1", displayName: "Claude Opus 4.1" },
  ],
  google: [
    { id: "gemini-3-pro-preview", displayName: "Gemini 3 Pro" },
    { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" },
  ],
  openrouter: [],
  xai: [
    { id: "grok-4-1-fast-reasoning", displayName: "Grok 4.1 Fast (Reasoning)" },
    { id: "grok-4-1-fast-non-reasoning", displayName: "Grok 4.1 Fast (Non-Reasoning)" },
    { id: "grok-4-fast-reasoning", displayName: "Grok 4 Fast (Reasoning)" },
    { id: "grok-4-fast-non-reasoning", displayName: "Grok 4 Fast (Non-Reasoning)" },
    { id: "grok-code-fast-1", displayName: "Grok Code Fast" },
    { id: "grok-4-0709", displayName: "Grok 4 (0709)" },
    { id: "grok-3-mini", displayName: "Grok 3 Mini" },
  ],
  ai_gateway: [],
  alibaba: [
    { id: "qwen3-max", displayName: "Qwen3 Max" },
    { id: "qwen3-plus", displayName: "Qwen3 Plus" },
    { id: "qwen-plus", displayName: "Qwen Plus" },
    { id: "qwen-turbo", displayName: "Qwen Turbo" },
    { id: "qwen-max", displayName: "Qwen Max" },
  ],

  cerebras: [],
  deepseek: [{ id: "deepseek-chat", displayName: "DeepSeek Chat" }],
  fireworks: [],

  groq: [],
  minimax: [
    { id: "MiniMax-M2", displayName: "MiniMax M2" },
    { id: "MiniMax-M2-Stable", displayName: "MiniMax M2 Stable" },
  ],
  mistral: [
    { id: "mistral-large-latest", displayName: "Mistral Large" },
    { id: "mistral-medium-latest", displayName: "Mistral Medium" },
    { id: "mistral-small-latest", displayName: "Mistral Small" },
    { id: "ministral-14b-latest", displayName: "Ministral 14B" },
    { id: "ministral-8b-latest", displayName: "Ministral 8B" },
    { id: "ministral-3b-latest", displayName: "Ministral 3B" },
    { id: "magistral-medium-latest", displayName: "Magistral Medium" },
    { id: "magistral-small-latest", displayName: "Magistral Small" },
  ],
  moonshotai: [
    { id: "kimi-k2.5", displayName: "Kimi K2.5" },
    { id: "kimi-k2", displayName: "Kimi K2" },
    { id: "kimi-k2-thinking", displayName: "Kimi K2 Thinking" },
    { id: "kimi-k2-thinking-turbo", displayName: "Kimi K2 Thinking Turbo" },
    { id: "kimi-k2-turbo", displayName: "Kimi K2 Turbo" },
    { id: "moonshot-v1-128k", displayName: "Moonshot V1 128K" },
    { id: "moonshot-v1-32k", displayName: "Moonshot V1 32K" },
    { id: "moonshot-v1-8k", displayName: "Moonshot V1 8K" },
  ],
  ollama: [],
  togetherai: [],
} as const satisfies Record<string, readonly StaticModelEntry[]>;

export type ProviderName = keyof typeof STATIC_PROVIDER_MODELS;

/**
 * List of all available providers
 */
export const AVAILABLE_PROVIDERS = Object.keys(STATIC_PROVIDER_MODELS) as ProviderName[];
