import {
  STATIC_PROVIDER_MODELS,
  type ProviderName,
  type StaticModelEntry,
} from "@/core/constants/models";

/**
 * This type represents how models are fetched for each provider.
 * Static models come from core constants (just IDs + displayName); metadata resolved via models.dev.
 * Dynamic models are fetched from provider API endpoints.
 */
export type ModelSource =
  | { type: "static"; models: readonly StaticModelEntry[] }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/api";

export const PROVIDER_MODELS: Record<ProviderName, ModelSource> = {
  anthropic: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.anthropic,
  },
  openai: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.openai,
  },
  google: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.google,
  },
  xai: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.xai,
  },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models",
    defaultBaseUrl: "https://openrouter.ai",
  },
  ai_gateway: {
    type: "dynamic",
    endpointPath: "",
  },
  alibaba: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.alibaba,
  },
  cerebras: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.cerebras.ai",
  },
  deepseek: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.deepseek,
  },
  fireworks: {
    type: "dynamic",
    endpointPath: "/v1/accounts/fireworks/models?pageSize=200",
    defaultBaseUrl: "https://api.fireworks.ai",
  },
  groq: {
    type: "dynamic",
    endpointPath: "/models",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  minimax: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.minimax,
  },
  mistral: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.mistral,
  },
  moonshotai: {
    type: "static",
    models: STATIC_PROVIDER_MODELS.moonshotai,
  },
  ollama: {
    type: "dynamic",
    endpointPath: "/tags",
    defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
  togetherai: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.together.xyz",
  },
} as const;
