import { Context, Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { ChatCompletionOptions, ChatCompletionResponse } from "@/core/types/chat";
import type { LLMConfig } from "@/core/types/config";
import type { LLMConfigurationError, LLMError } from "@/core/types/errors";
import type { LLMProvider, LLMProviderListItem, StreamingResult } from "../types";

/**
 * The subset of `ollama show`'s response the agent runner needs to decide what a local model
 * can actually ingest — Ollama reports this per model file, which the models.dev catalog
 * usually knows nothing about (most local tags aren't in it at all).
 */
export interface OllamaShowExtras {
  readonly contextWindow?: number;
  readonly template?: string;
  readonly capabilities?: readonly string[];
}

export interface LLMService {
  /**
   * Get a provider by name
   */
  readonly getProvider: (
    providerName: ProviderName,
  ) => Effect.Effect<LLMProvider, LLMConfigurationError>;

  /**
   * List all providers
   */
  readonly listProviders: () => Effect.Effect<readonly LLMProviderListItem[], never>;

  /**
   * Create a non-streaming chat completion
   */
  readonly createChatCompletion: (
    providerName: ProviderName,
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;

  /**
   * Create a streaming chat completion
   */
  readonly createStreamingChatCompletion: (
    providerName: ProviderName,
    options: ChatCompletionOptions,
  ) => Effect.Effect<StreamingResult, LLMError>;

  /**
   * Check if a provider supports native web search
   */
  readonly supportsNativeWebSearch: (providerName: ProviderName) => Effect.Effect<boolean, never>;

  /**
   * Fetches `ollama show`'s capabilities/context-window detail for one local model, over the
   * network. Used only to decide what a local model can ingest — see {@link OllamaShowExtras}.
   */
  readonly fetchOllamaModelDetails: (
    baseUrl: string,
    model: string,
  ) => Effect.Effect<OllamaShowExtras, unknown>;

  /**
   * Resolves the base URL a local provider (Ollama, llama.cpp) is reachable at, from config,
   * then the environment, then the provider's own default.
   */
  readonly resolveLocalProviderBaseUrl: (
    provider: "llamacpp" | "ollama",
    llmConfig?: LLMConfig,
  ) => string;
}

/**
 * Service tag for dependency injection
 */
export const LLMServiceTag = Context.GenericTag<LLMService>("LLMService");
