import { gateway } from "ai";
import { Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
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

// Provider-specific response transformers
const PROVIDER_TRANSFORMERS: Partial<Record<ProviderName, (data: unknown) => ModelInfo[]>> = {
  ollama: (data: unknown) => {
    // Transform Ollama API response
    const response = data as {
      models?: OllamaModel[];
    };

    const ollamaReasoningModels: string[] = [
      "gpt-oss",
      "deepseek-r1",
      "deepseek-v3.1",
      "qwen3",
      "magistral",
    ];

    return (response.models ?? []).map((model) => ({
      id: model.name,
      displayName: model.name,
      isReasoningModel: ollamaReasoningModels.some((reasoningModel) =>
        model.name.includes(reasoningModel),
      ),
      supportsTools: looksToolCapable(model),
    }));
  },
  openrouter: (data: unknown) => {
    // Transform OpenRouter API response
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
      };
    });
  },
};

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

          // Select transformer based on provider name
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
