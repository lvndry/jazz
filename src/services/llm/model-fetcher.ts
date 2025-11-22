import { Effect } from "effect";
import { LLMConfigurationError } from "../../core/types/errors";
import type { ModelInfo, ProviderName } from "./models";

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
    // Example: { models: [{ name: "llama3:latest", model: "llama3:latest", ... }] }
    const response = data as {
      models?: Array<{
        name: string;
        model?: string;
        [key: string]: unknown;
      }>;
    };

    return (response.models ?? []).map((model) => ({
      id: model.name,
      displayName: model.name,
      isReasoningModel: false,
    }));
  },
  openrouter: (data: unknown) => {
    // Transform OpenRouter API response
    // Example: { data: [{ id: "openai/gpt-4o", name: "GPT-4o", ... }] }
    const response = data as {
      data?: Array<{
        id: string;
        name?: string;
        description?: string;
        architecture?: {
          instruct_type?: string;
        };
        [key: string]: unknown;
      }>;
    };

    return (response.data ?? []).map((model) => {
      // Heuristic: Models with "reasoning", "o1", "r1", or "thinking" in ID/name are likely reasoning models
      const modelIdLower = model.id.toLowerCase();
      const modelNameLower = (model.name ?? "").toLowerCase();
      const isReasoningModel =
        modelIdLower.includes("reasoning") ||
        modelIdLower.includes("/o1") ||
        modelIdLower.includes("-o1") ||
        modelIdLower.includes("r1") ||
        modelIdLower.includes("thinking") ||
        modelNameLower.includes("reasoning") ||
        modelNameLower.includes("thinking");

      return {
        id: model.id,
        displayName: model.name ?? model.id,
        isReasoningModel,
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
