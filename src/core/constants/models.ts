/**
 * Provider registry.
 *
 * Model lists are NOT hardcoded. Every provider resolves its models at runtime:
 * - Catalog-backed providers (openai, anthropic, gemini, ...) list models from
 *   https://models.dev/api.json (fetched lazily, cached in memory for 1 hour).
 * - Dynamic providers (openrouter, groq, ollama, ...) list models from their own
 *   API endpoints, with models.dev used for best-effort metadata enrichment.
 *
 * See src/services/llm/models.ts for the per-provider model source mapping and
 * src/core/utils/models-dev.ts for the models.dev catalog integration.
 *
 * The provider names are defined here as the source of truth, and the ProviderName
 * type is derived from this constant to ensure they stay in sync.
 */

/**
 * Default context window size for models without explicit specification.
 * 128k is a reasonable default as it's the most common context window size.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * List of all available providers
 */
export const AVAILABLE_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "xai",
  "ai_gateway",
  "alibaba",
  "cerebras",
  "deepseek",
  "fireworks",
  "groq",
  "llamacpp",
  "minimax",
  "mistral",
  "moonshotai",
  "ollama",
  "togetherai",
  "zhipuai",
] as const;

export type ProviderName = (typeof AVAILABLE_PROVIDERS)[number];
