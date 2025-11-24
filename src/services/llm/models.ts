import { STATIC_PROVIDER_MODELS, type ProviderName } from "../../core/constants/models";
import type { ModelInfo } from "../../core/types";

/**
 * Infrastructure-specific model source configuration
 *
 * This type represents how models are fetched for each provider.
 * Static models come from core constants, dynamic models require infrastructure config.
 */
export type ModelSource =
  | { type: "static"; models: readonly ModelInfo[] }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

/**
 * Default base URL for Ollama (infrastructure constant)
 */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/api";

/**
 * Provider model configuration combining static models from core with infrastructure config
 *
 * Static providers use models from core/constants/models.ts
 * Dynamic providers (like Ollama) require endpoint configuration
 */
export const PROVIDER_MODELS: Record<ProviderName, ModelSource> = {
  openai: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.openai,
  },
  anthropic: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.anthropic,
  },
  google: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.google,
  },
  mistral: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.mistral,
  },
  xai: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.xai,
  },
  deepseek: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.deepseek,
  },
  ollama: {
    type: "dynamic",
    endpointPath: "/tags",
    defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models",
    defaultBaseUrl: "https://openrouter.ai",
  },
} as const;
