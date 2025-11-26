import { Context, Effect } from "effect";
import type { ProviderName } from "../constants/models";
import type { LLMProvider, StreamingResult } from "../types";
import type { ChatCompletionOptions, ChatCompletionResponse } from "../types/chat";
import type { LLMConfigurationError, LLMError } from "../types/errors";

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
    readonly { name: ProviderName; configured: boolean }[],
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
