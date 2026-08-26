import type { ProviderName } from "@/core/constants/models";
import { isOllamaCloudModel } from "@/core/constants/ollama";
import type { LLMConfig } from "@/core/types/config";

/**
 * This type represents how models are fetched for each provider.
 * Catalog-backed providers list models (and metadata) from models.dev.
 * Dynamic models are fetched from provider API endpoints.
 */
export type ModelSource =
  | {
      type: "models-dev";
      /**
       * Provider id to look up in the models.dev catalog, when it differs from
       * Jazz's own provider name. models.dev lists Gemini under "google", and
       * that id belongs to their API, not to us.
       */
      catalogId?: string;
    }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/api";
export const OLLAMA_CLOUD_API_ROOT = "https://ollama.com/api";
export const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080/v1";

export const PROVIDER_MODELS: Record<ProviderName, ModelSource> = {
  anthropic: { type: "models-dev" },
  openai: { type: "models-dev" },
  gemini: { type: "models-dev", catalogId: "google" },
  xai: { type: "models-dev" },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models?sort=most-popular",
    defaultBaseUrl: "https://openrouter.ai",
  },
  ai_gateway: { type: "dynamic", endpointPath: "" },
  alibaba: { type: "models-dev" },
  cerebras: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.cerebras.ai",
  },
  deepseek: { type: "models-dev" },
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
  minimax: { type: "models-dev" },
  mistral: { type: "models-dev" },
  moonshotai: { type: "models-dev" },
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
  zhipuai: { type: "models-dev" },
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

function isLoopbackOllamaHost(url: string): boolean {
  try {
    const parsed = new URL(url.includes("://") ? url : `http://${url}`);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function ollamaApiKey(llmConfig?: LLMConfig): string | undefined {
  const fromConfig = llmConfig?.ollama?.api_key;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) return fromConfig;
  const fromEnv = process.env["OLLAMA_API_KEY"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  return undefined;
}

/**
 * Where a chat request for this Ollama model should go.
 *
 * Cloud models authenticate at ollama.com with an API key. Sending that key to
 * localhost does nothing — the local daemon uses `ollama signin`, not Bearer
 * tokens. If the user pointed `base_url` at a non-loopback host, that still wins.
 */
export function resolveOllamaRequestBaseUrl(modelId: string, llmConfig?: LLMConfig): string {
  if (isOllamaCloudModel(modelId) && ollamaApiKey(llmConfig)) {
    const fromConfig = llmConfig?.ollama?.base_url;
    const fromEnv = process.env["OLLAMA_BASE_URL"];
    const explicit =
      fromConfig && fromConfig.length > 0
        ? fromConfig
        : fromEnv && fromEnv.length > 0
          ? fromEnv
          : undefined;
    if (explicit && !isLoopbackOllamaHost(explicit)) {
      return toOllamaApiRoot(explicit);
    }
    return OLLAMA_CLOUD_API_ROOT;
  }

  return resolveLocalProviderBaseUrl("ollama", llmConfig);
}
