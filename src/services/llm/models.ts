import {
  STATIC_PROVIDER_MODELS,
  type ProviderName,
  type StaticModelEntry,
} from "@/core/constants/models";
import type { LLMConfig } from "@/core/types/config";

/**
 * This type represents how models are fetched for each provider.
 * Static models come from core constants (just IDs + displayName); metadata resolved via models.dev.
 * Dynamic models are fetched from provider API endpoints.
 */
export type ModelSource =
  | { type: "static"; models: readonly StaticModelEntry[] }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/api";
export const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080/v1";

export const PROVIDER_MODELS: Record<ProviderName, ModelSource> = {
  anthropic: { type: "static", models: STATIC_PROVIDER_MODELS.anthropic },
  openai: { type: "static", models: STATIC_PROVIDER_MODELS.openai },
  google: { type: "static", models: STATIC_PROVIDER_MODELS.google },
  xai: { type: "static", models: STATIC_PROVIDER_MODELS.xai },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models",
    defaultBaseUrl: "https://openrouter.ai",
  },
  ai_gateway: { type: "dynamic", endpointPath: "" },
  alibaba: { type: "static", models: STATIC_PROVIDER_MODELS.alibaba },
  cerebras: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.cerebras.ai",
  },
  deepseek: { type: "static", models: STATIC_PROVIDER_MODELS.deepseek },
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
  minimax: { type: "static", models: STATIC_PROVIDER_MODELS.minimax },
  mistral: { type: "static", models: STATIC_PROVIDER_MODELS.mistral },
  moonshotai: { type: "static", models: STATIC_PROVIDER_MODELS.moonshotai },
  ollama: { type: "dynamic", endpointPath: "/tags", defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL },
  llamacpp: {
    type: "dynamic",
    endpointPath: "/models",
    defaultBaseUrl: DEFAULT_LLAMACPP_BASE_URL,
  },
  togetherai: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.together.xyz",
  },
} as const;

/**
 * Canonicalize an Ollama base URL to its REST API root (ending in `/api`).
 *
 * Ollama's REST endpoints (`/tags`, `/show`) and the ai-sdk provider all treat the base URL as the
 * `/api` root. A config/env value may be written with or without `/api` (or a trailing slash), so
 * normalize it here — the single place every consumer resolves the URL — to guarantee consistency
 * and avoid mistakes like a doubled `/api/api`.
 */
function toOllamaApiRoot(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.length === 0) return trimmed;
  return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
}

/**
 * Resolve the base URL for a local-server provider. Precedence:
 *   1. llmConfig.<provider>.base_url
 *   2. <PROVIDER>_BASE_URL env var
 *   3. PROVIDER_MODELS[<provider>].defaultBaseUrl
 *
 * For Ollama the result is canonicalized to the `/api` root so every consumer agrees on the base.
 */
export function resolveLocalProviderBaseUrl(
  provider: "llamacpp" | "ollama",
  llmConfig?: LLMConfig,
): string {
  const fromConfig = llmConfig?.[provider]?.base_url;
  const envVar = provider === "llamacpp" ? "LLAMACPP_BASE_URL" : "OLLAMA_BASE_URL";
  const fromEnv = process.env[envVar];
  const source = PROVIDER_MODELS[provider];
  const fallback = source.type === "dynamic" ? source.defaultBaseUrl : undefined;

  let resolved: string;
  if (fromConfig && fromConfig.length > 0) {
    resolved = fromConfig;
  } else if (fromEnv && fromEnv.length > 0) {
    resolved = fromEnv;
  } else {
    resolved = fallback ?? "";
  }

  return provider === "ollama" ? toOllamaApiRoot(resolved) : resolved;
}
