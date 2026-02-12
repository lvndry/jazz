import { gateway } from "ai";
import { Effect } from "effect";
import { DEFAULT_CONTEXT_WINDOW, type ProviderName } from "@/core/constants/models";
import type { ModelInfo } from "@/core/types";
import { LLMConfigurationError } from "@/core/types/errors";
import {
  getMetadataFromMap,
  getModelsDevMap,
  type ModelsDevMetadata,
} from "@/core/utils/models-dev-client";

/**
 * Model fetcher: models.dev as single source of metadata
 *
 * Architecture:
 * 1. Fetch models.dev once at start of fetchModels() for metadata (context, tool_call, reasoning).
 * 2. Each provider only supplies the list of models: id + displayName + optional fallback metadata.
 * 3. Shared resolve step: for each model, use models.dev when present, else provider fallback or defaults.
 * 4. No per-provider metadata heuristics; fallbacks only for models not in models.dev (e.g. Ollama /api/show).
 */

export interface ModelFetcherService {
  fetchModels(
    providerName: ProviderName,
    baseUrl: string,
    endpointPath: string,
    apiKey?: string,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never>;
}

/** Per-model entry from a provider before resolving metadata (models.dev or fallback). */
type RawModelEntry = {
  id: string;
  displayName: string;
  fallback?: Partial<ModelsDevMetadata>;
};

/** Resolve to ModelInfo: models.dev first, then entry.fallback, then defaults. */
function resolveToModelInfo(
  entry: RawModelEntry,
  devMap: Map<string, ModelsDevMetadata> | null,
): ModelInfo {
  const dev = getMetadataFromMap(devMap, entry.id);
  if (dev) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      contextWindow: dev.contextWindow,
      supportsTools: dev.supportsTools,
      isReasoningModel: dev.isReasoningModel,
    };
  }
  const fb = entry.fallback;
  return {
    id: entry.id,
    displayName: entry.displayName,
    contextWindow: fb?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    supportsTools: fb?.supportsTools ?? false,
    isReasoningModel: fb?.isReasoningModel ?? false,
  };
}

type OpenRouterModel = {
  id: string;
  name: string;
  context_length?: number;
  supported_parameters?: string[];
};

type OllamaModel = {
  name: string;
  model?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    metadata?: Record<string, unknown>;
  };
};

/**
 * Response from Ollama /api/show endpoint
 */
type OllamaShowResponse = {
  model_info?: Record<string, unknown>;
  details?: {
    family?: string;
  };
};

/**
 * Extract context length from Ollama model_info
 * The key format is `<family>.context_length` (e.g., "gemma3.context_length")
 */
function extractOllamaContextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | undefined {
  if (!modelInfo) return undefined;

  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/**
 * Fetch detailed model info from Ollama /api/show endpoint
 * Returns the context window size, or undefined if not available
 */
async function fetchOllamaModelDetails(
  baseUrl: string,
  modelName: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as OllamaShowResponse;
    return extractOllamaContextLength(data.model_info);
  } catch {
    return undefined;
  }
}

const TOOL_PARAMS = new Set([
  "tools",
  "tool_choice",
  "function_call",
  "functions",
  "response_format:json_schema",
]);

/**
 * Fallback when model is not in models.dev: read tool support from Ollama manifest metadata.
 */
function ollamaToolSupportFromMetadata(model: OllamaModel): boolean {
  const metadata = model.details?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const flag = metadata["supports_tools"] ?? metadata["tool_use"] ?? metadata["function_calling"];
  return typeof flag === "boolean" && flag;
}

// List extractors: provider API response → RawModelEntry[] (metadata resolved via models.dev or fallback)
const LIST_EXTRACTORS: Partial<Record<ProviderName, (data: unknown) => RawModelEntry[]>> = {
  openrouter: (data: unknown) => {
    const response = data as { data?: OpenRouterModel[] };
    return (response.data ?? []).map((model) => {
      const supportedParameters = model.supported_parameters ?? [];
      const isReasoningModel =
        supportedParameters.includes("reasoning") ||
        supportedParameters.includes("include_reasoning");
      const supportsTools = supportedParameters.some((param) => TOOL_PARAMS.has(param));
      return {
        id: model.id,
        displayName: model.name,
        fallback: {
          contextWindow: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
          supportsTools,
          isReasoningModel,
        },
      };
    });
  },
  ai_gateway: (data: unknown) => {
    const response = data as { id: string; name: string; tags?: string[] }[];
    return response.map((model) => ({
      id: model.id,
      displayName: model.name,
      fallback: {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        supportsTools: model.tags?.includes("tool-use") ?? false,
        isReasoningModel: model.tags?.includes("reasoning") ?? false,
      },
    }));
  },
  groq: (data: unknown) => {
    const response = data as {
      data: { id: string; owned_by: string }[];
    };
    return response.data.map((model) => ({
      id: model.id,
      displayName: `${model.owned_by.toLowerCase()}/${model.id.toLowerCase()}`,
      // no fallback; models.dev or defaults
    }));
  },
};

/**
 * Ollama: list from /api/tags, resolve via models.dev or async fallback (/api/show + metadata).
 */
async function transformOllamaModels(
  data: unknown,
  baseUrl: string,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
): Promise<ModelInfo[]> {
  const response = data as { models?: OllamaModel[] };
  const models = response.models ?? [];
  const CONCURRENCY_LIMIT = 5;
  const results: ModelInfo[] = [];

  for (let i = 0; i < models.length; i += CONCURRENCY_LIMIT) {
    const batch = models.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (model): Promise<ModelInfo> => {
        const entry: RawModelEntry = {
          id: model.name,
          displayName: model.name,
        };
        const dev = getMetadataFromMap(modelsDevMap, model.name);
        if (dev) {
          return resolveToModelInfo(entry, modelsDevMap);
        }
        const contextWindow = await fetchOllamaModelDetails(baseUrl, model.name);
        entry.fallback = {
          contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          supportsTools: ollamaToolSupportFromMetadata(model),
          isReasoningModel: false, // Only models.dev knows reasoning; no Ollama manifest field for this
        };
        return resolveToModelInfo(entry, null);
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

export function createModelFetcher(): ModelFetcherService {
  return {
    fetchModels: (providerName, baseUrl, endpointPath, apiKey) =>
      Effect.tryPromise({
        try: async () => {
          const url = `${baseUrl}${endpointPath}`;
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };

          if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
          }

          const modelsDevMap = await getModelsDevMap();

          if (providerName === "ai_gateway") {
            const availableModels = await gateway.getAvailableModels();
            const extractor = LIST_EXTRACTORS["ai_gateway"]!;
            const raw = extractor(availableModels.models);
            return raw.map((entry) => resolveToModelInfo(entry, modelsDevMap));
          }

          const response = await fetch(url, {
            method: "GET",
            headers,
          });

          if (!response.ok) {
            if (response.status === 404) {
              if (providerName === "ollama") {
                throw new Error(
                  "Failed to fetch models: No models found. Pull a model using `ollama pull` first.",
                );
              }
            }

            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
          }

          const data: unknown = await response.json();

          if (providerName === "ollama") {
            return transformOllamaModels(data, baseUrl, modelsDevMap);
          }

          const extractor = LIST_EXTRACTORS[providerName];
          if (!extractor) {
            throw new Error(`No list extractor found for provider: ${providerName}`);
          }
          const raw = extractor(data);
          return raw.map((entry) => resolveToModelInfo(entry, modelsDevMap));
        },
        catch: (error) =>
          new LLMConfigurationError({
            provider: providerName,
            message: `Model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
  };
}
