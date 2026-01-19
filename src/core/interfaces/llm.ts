import { Context, Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { LLMProvider, LLMProviderListItem, StreamingResult } from "../types";
import type { ChatCompletionOptions, ChatCompletionResponse } from "@/core/types/chat";
import type { LLMConfigurationError, LLMError } from "@/core/types/errors";

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
  readonly listProviders: () => Effect.Effect<
    readonly LLMProviderListItem[],
    never
  >;

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
}

/**
 * Service tag for dependency injection
 */
export const LLMServiceTag = Context.GenericTag<LLMService>("LLMService");
