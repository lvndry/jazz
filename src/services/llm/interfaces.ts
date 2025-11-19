import { Context, Effect } from "effect";
import { LLMAuthenticationError, LLMConfigurationError, LLMError } from "../../core/types/errors";
import type { ChatCompletionOptions, ChatCompletionResponse, ModelInfo } from "./models";
import type { ProviderName } from "./providers";
import type { StreamingResult } from "./streaming-types";

/**
 * LLM Provider and Service interfaces
 */

export interface LLMProvider {
  readonly name: string;
  readonly supportedModels: ModelInfo[];
  readonly defaultModel: string;
  readonly authenticate: () => Effect.Effect<void, LLMAuthenticationError>;
  readonly createChatCompletion: (
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;
}


export interface LLMService {
  readonly getProvider: (providerName: ProviderName) => Effect.Effect<LLMProvider, LLMConfigurationError>;
  readonly listProviders: () => Effect.Effect<readonly string[], never>;

  /**
   * Create a non-streaming chat completion
   */
  readonly createChatCompletion: (
    providerName: string,
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;

  /**
   * Create a streaming chat completion
   */
  readonly createStreamingChatCompletion: (
    providerName: string,
    options: ChatCompletionOptions,
  ) => Effect.Effect<StreamingResult, LLMError>;
}

// Service tag for dependency injection
export const LLMServiceTag = Context.GenericTag<LLMService>("LLMService");
