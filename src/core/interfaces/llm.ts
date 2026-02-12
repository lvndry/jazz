import { Context, Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { ChatCompletionOptions, ChatCompletionResponse } from "@/core/types/chat";
import type { LLMConfigurationError, LLMError } from "@/core/types/errors";
import type { LLMProvider, LLMProviderListItem, StreamingResult } from "../types";

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
}

/**
 * Service tag for dependency injection
 */
export const LLMServiceTag = Context.GenericTag<LLMService>("LLMService");
