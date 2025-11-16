import { Context, Effect } from "effect";
import type z from "zod";
import type { StreamingResult } from "./streaming-types";

/**
 * LLM service types and interfaces
 */

// Base error types
export class LLMAuthenticationError extends Error {
  readonly _tag = "LLMAuthenticationError";
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "LLMAuthenticationError";
  }
}

export class LLMRequestError extends Error {
  readonly _tag = "LLMRequestError";
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);

    this.name = "LLMRequestError";
  }
}

export class LLMRateLimitError extends Error {
  readonly _tag = "LLMRateLimitError";
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "LLMRateLimitError";
  }
}

export class LLMConfigurationError extends Error {
  readonly _tag = "LLMConfigurationError";
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "LLMConfigurationError";
  }
}

export type LLMError =
  | LLMAuthenticationError
  | LLMRequestError
  | LLMRateLimitError
  | LLMConfigurationError;

// Message types
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  /**
   * For role === "tool": the id of the tool call this message responds to
   */
  tool_call_id?: string;
  /**
   * For role === "assistant": include tool calls emitted by the model so that
   * subsequent tool messages are valid according to the OpenAI API.
   */
  tool_calls?: ReadonlyArray<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

// Tool/Function calling types
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResult {
  toolCallId: string;
  role: "tool";
  name: string;
  content: string;
}

// Model response
export interface ChatCompletionResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Model request options
export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  reasoning_effort?: "disable" | "low" | "medium" | "high";
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly isReasoningModel?: boolean;
}

// LLM Provider interface
export interface LLMProvider {
  readonly name: string;
  readonly supportedModels: ModelInfo[];
  readonly defaultModel: string;
  readonly authenticate: () => Effect.Effect<void, LLMAuthenticationError>;
  readonly createChatCompletion: (
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;
}

// LLM Service interface
export interface LLMService {
  readonly getProvider: (providerName: string) => Effect.Effect<LLMProvider, LLMConfigurationError>;
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
