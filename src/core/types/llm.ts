import { Effect, Stream } from "effect";
import type { LLMError } from "./errors";
import type { ChatMessage } from "./message";
import type { ToolCall, ToolDefinition } from "./tools";

/**
 * Model Information
 */
export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly isReasoningModel?: boolean;
}

export type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "xai"
  | "deepseek"
  | "ollama";

/**
 * Chat Completion Types
 */
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

/**
 * Streaming Types
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  // Stream lifecycle
  | {
      type: "stream_start";
      provider: string;
      model: string;
      timestamp: number;
    }
  | {
      type: "complete";
      response: ChatCompletionResponse;
      totalDurationMs: number;
      metrics?: {
        firstTokenLatencyMs: number;
        firstTextLatencyMs?: number;
        firstReasoningLatencyMs?: number;
        tokensPerSecond?: number;
        totalTokens?: number;
      };
    }
  | { type: "error"; error: LLMError; recoverable: boolean }

  // Thinking/reasoning
  | { type: "thinking_start"; provider: string }
  | { type: "thinking_chunk"; content: string; sequence: number }
  | { type: "thinking_complete"; totalTokens?: number }

  // Text content
  | { type: "text_start" }
  | { type: "text_chunk"; delta: string; accumulated: string; sequence: number }

  // Tool calls
  | { type: "tool_call"; toolCall: ToolCall; sequence: number }
  | { type: "tools_detected"; toolNames: readonly string[]; agentName: string }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      arguments?: Record<string, unknown>;
    }
  | {
      type: "tool_execution_complete";
      toolCallId: string;
      result: string;
      durationMs: number;
      summary?: string;
    }

  // Usage updates
  | { type: "usage_update"; usage: TokenUsage };

export interface StreamingResult {
  readonly stream: Stream.Stream<StreamEvent, LLMError>;
  readonly response: Effect.Effect<ChatCompletionResponse, LLMError>;
  readonly cancel: Effect.Effect<void, never>;
}
