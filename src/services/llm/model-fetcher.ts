import { gateway } from "ai";
import { Effect } from "effect";
import type { ProviderName } from "../../core/constants/models";
import type { ModelInfo } from "../../core/types";
import { LLMConfigurationError } from "../../core/types/errors";

export interface ModelFetcherService {
  fetchModels(
    providerName: ProviderName,
    baseUrl: string,
    endpointPath: string,
    apiKey?: string,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never>;
}

// Provider-specific response transformers
const PROVIDER_TRANSFORMERS: Partial<Record<ProviderName, (data: unknown) => ModelInfo[]>> = {
  ollama: (data: unknown) => {
    // Transform Ollama API response
    const response = data as {
      models?: {
        name: string;
        model?: string;
      }[];
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
    }));
  },
  openrouter: (data: unknown) => {
    // Transform OpenRouter API response
    const response = data as {
      data?: {
        id: string;
        name: string;
        supported_parameters: string[];
      }[];
    };

    return (response.data ?? []).map((model) => {
      const isReasoningModel =
        model.supported_parameters.includes("reasoning") ||
        model.supported_parameters.includes("include_reasoning");

      return {
        id: model.id,
        displayName: model.name,
        isReasoningModel,
      };
    });
  },
  ai_gateway: (data: unknown) => {
    const response = data as {
      id: string;
      name: string;
    }[];

    return response.map((model) => ({
      id: model.id,
      displayName: model.name,
      isReasoningModel: false,
    }));
  },
  groq: (data: unknown) => {
    const response = data as {
      data: {
        id: string;
        owned_by: string;
      }[];
    };

    return response.data.map((model) => ({
      id: model.id,
      displayName: `${model.owned_by.toLowerCase()}/${model.id.toLowerCase()}`,
      isReasoningModel: false,
    }));
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
