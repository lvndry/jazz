import { gateway } from "ai";
import { Effect } from "effect";
import { DEFAULT_CONTEXT_WINDOW, type ProviderName } from "@/core/constants/models";
import type { ModelInfo } from "@/core/types";
import { LLMConfigurationError } from "@/core/types/errors";

export interface ModelFetcherService {
  fetchModels(
    providerName: ProviderName,
    baseUrl: string,
    endpointPath: string,
    apiKey?: string,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never>;
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
function extractOllamaContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
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

    const data = await response.json() as OllamaShowResponse;
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

// Prefixes for known Ollama models that support tool/function calling
const KNOWN_OLLAMA_TOOL_MODEL_PREFIXES = [
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "qwen2.5",
  "qwen3",
  "qwen3-coder",
  "qwen3-vl",
  "phi3.5",
  "phi4",
  "mistral",
  "mixtral",
  "nemotron",
  "devstral",
  "ministral",
  "deepseek-v3",
  "command-r",
  "granite3",
  "firefunction",
  "functiongemma",
];

function looksToolCapable(model: OllamaModel): boolean {
  const name = model.name.toLowerCase();
  if (KNOWN_OLLAMA_TOOL_MODEL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (name.includes("tool") || name.includes("function")) return true;

  const metadata = model.details?.metadata;
  if (metadata && typeof metadata === "object") {
    const flag =
      metadata["supports_tools"] ??
      metadata["tool_use"] ??
      metadata["function_calling"];
    if (typeof flag === "boolean") return flag;
  }

  return false;
}

// Provider-specific response transformers (sync)
const PROVIDER_TRANSFORMERS: Partial<Record<ProviderName, (data: unknown) => ModelInfo[]>> = {
  openrouter: (data: unknown) => {
    // Transform OpenRouter API response - includes context_length
    const response = data as {
      data?: OpenRouterModel[];
    };

    return (response.data ?? []).map((model) => {
      const supportedParameters = model.supported_parameters ?? [];
      const isReasoningModel =
        supportedParameters.includes("reasoning") ||
        supportedParameters.includes("include_reasoning");
      const supportsTools = supportedParameters.some((param) => TOOL_PARAMS.has(param));

      return {
        id: model.id,
        displayName: model.name,
        isReasoningModel,
        supportsTools,
        // Use context_length from API if available, otherwise use default
        contextWindow: model.context_length ?? DEFAULT_CONTEXT_WINDOW,
      };
    });
  },
  ai_gateway: (data: unknown) => {
    const response = data as {
      id: string;
      name: string;
      tags?: string[];
    }[];

    return response.map((model) => ({
      id: model.id,
      displayName: model.name,
      isReasoningModel: model.tags?.includes("reasoning") ?? false,
      supportsTools: model.tags?.includes("tool-use") ?? false,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    }));
  },
  groq: (data: unknown) => {
    const response = data as {
      data: {
        id: string;
        owned_by: string;
      }[];
    };

    // Groq models that support tool use (per https://console.groq.com/docs/tool-use/overview)
    const groqToolModelPrefixes = [
      "llama",
      "llama3",
      "mixtral",
      "gemma",
      "gemma2",
      "qwen",
      "deepseek",
    ];

    return response.data.map((model) => {
      const modelId = model.id.toLowerCase();
      const supportsTools = groqToolModelPrefixes.some((prefix) => modelId.startsWith(prefix));

      return {
        id: model.id,
        displayName: `${model.owned_by.toLowerCase()}/${model.id.toLowerCase()}`,
        isReasoningModel: false,
        supportsTools,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
      };
    });
  },
};

// Ollama reasoning model prefixes
const OLLAMA_REASONING_MODELS = [
  "gpt-oss",
  "deepseek-r1",
  "deepseek-v3.1",
  "qwen3",
  "magistral",
];

/**
 * Async transformer for Ollama that fetches context window from /api/show
 */
async function transformOllamaModels(
  data: unknown,
  baseUrl: string,
): Promise<ModelInfo[]> {
  const response = data as {
    models?: OllamaModel[];
  };

  const models = response.models ?? [];

  // Fetch details for each model in parallel (with concurrency limit)
  const CONCURRENCY_LIMIT = 5;
  const results: ModelInfo[] = [];

  for (let i = 0; i < models.length; i += CONCURRENCY_LIMIT) {
    const batch = models.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const contextWindow = await fetchOllamaModelDetails(baseUrl, model.name);

        return {
          id: model.name,
          displayName: model.name,
          isReasoningModel: OLLAMA_REASONING_MODELS.some((reasoningModel) =>
            model.name.includes(reasoningModel),
          ),
          supportsTools: looksToolCapable(model),
          contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        };
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

          if (providerName === "ai_gateway") {
            const availableModels = await gateway.getAvailableModels();
            return PROVIDER_TRANSFORMERS["ai_gateway"]!(availableModels.models);
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

          // Ollama uses async transformer to fetch context window from /api/show
          if (providerName === "ollama") {
            return transformOllamaModels(data, baseUrl);
          }

          // Select sync transformer based on provider name
          const transformer = PROVIDER_TRANSFORMERS[providerName];
          if (!transformer) {
            throw new Error(`No transformer found for provider: ${providerName}`);
          }
          return transformer(data);
        },
        catch: (error) =>
          new LLMConfigurationError({
            provider: providerName,
            message: `Model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
  };
}
