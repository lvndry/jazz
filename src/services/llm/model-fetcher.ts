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
    // Example: { models: [{ name: "llama3:latest", model: "llama3:latest", ... }] }
    const response = data as {
      models?: Array<{
        name: string;
        model?: string;
      }>;
    };

    const ollamaReasoningModels: string[] = [
      "gpt-oss",
      "deepseek-r1",
      "deepseek-v3.1",
      "qwen3",
      "magistral",
    ];

    // Known Ollama models with tool/function calling support
    // This list includes model families that support tools
    const ollamaToolSupportPatterns: string[] = [
      "llama3.1", // Llama 3.1+ supports tools
      "llama3.2",
      "llama3.3",
      "llama-3.1",
      "llama-3.2",
      "llama-3.3",
      "mistral", // Mistral models support tools
      "mixtral",
      "qwen2.5", // Qwen 2.5+ supports tools
      "qwen3",
      "qwq",
      "command-r", // Cohere Command R supports tools
      "deepseek", // DeepSeek models support tools
      "hermes", // Hermes models (function calling variants)
      "functionary", // Functionary models are designed for function calling
      "gorilla", // Gorilla models for function calling
      "granite3", // IBM Granite 3+ supports tools
      "granite-3",
    ];

    return (response.models ?? []).map((model) => {
      const modelNameLower = model.name.toLowerCase();

      // Check if model supports tools based on name patterns
      const supportsTools = ollamaToolSupportPatterns.some((pattern) =>
        modelNameLower.includes(pattern.toLowerCase()),
      );

      return {
        id: model.name,
        displayName: model.name,
        isReasoningModel: ollamaReasoningModels.some((reasoningModel) =>
          model.name.includes(reasoningModel),
        ),
        supportsTools,
      };
    });
  },
  openrouter: (data: unknown) => {
    // Transform OpenRouter API response
    // Example: { data: [{ id: "openai/gpt-4o", name: "GPT-4o", ... }] }
    const response = data as {
      data?: Array<{
        id: string;
        name?: string;
        supported_parameters: string[];
      }>;
    };

    return (response.data ?? []).map((model) => {
      const isReasoningModel =
        model.supported_parameters.includes("reasoning") ||
        model.supported_parameters.includes("include_reasoning");

      // Check if model supports tools by looking for tool-related parameters
      const supportsTools =
        model.supported_parameters.includes("tools") ||
        model.supported_parameters.includes("tool_choice") ||
        model.supported_parameters.includes("function_calling") ||
        model.supported_parameters.includes("functions");

      return {
        id: model.id,
        displayName: model.name ?? model.id,
        isReasoningModel,
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
