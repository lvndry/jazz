import { Effect } from "effect";
import type { LLMAuthenticationError, LLMConfigurationError, LLMError } from "../types/errors";
import type {
  ChatCompletionOptions,
  ChatCompletionResponse,
  ModelInfo,
  ProviderName,
  StreamingResult,
} from "../types/llm";

export interface LLMProvider {
  readonly name: string;
  readonly supportedModels: ModelInfo[];
  readonly defaultModel: string;
  readonly authenticate: () => Effect.Effect<void, LLMAuthenticationError>;
}

export interface LLMService {
  readonly getProvider: (
    providerName: ProviderName,
  ) => Effect.Effect<LLMProvider, LLMConfigurationError>;
  readonly listProviders: () => Effect.Effect<
    readonly { name: string; configured: boolean }[],
    never
  >;

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
