import { Effect, Stream } from "effect";
import type { ChatCompletionResponse } from "./chat";
import type { LLMError } from "./errors";
import type { ToolCall } from "./tools";

/**
 * Streaming LLM types and interfaces
 */

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Structured streaming events - discriminated union
 * These events allow consumers to react to different phases of the streaming response
 */
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
      /**
       * Performance metrics (only included if logging.showMetrics is enabled)
       */
      metrics?: {
        firstTokenLatencyMs: number;
        firstTextLatencyMs?: number;
        firstReasoningLatencyMs?: number;
        tokensPerSecond?: number;
        totalTokens?: number;
      };
    }
  | { type: "error"; error: LLMError; recoverable: boolean }

  // Thinking/reasoning (for models like o1, Claude extended thinking, DeepSeek R1)
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

  // Usage updates (optional, for real-time token tracking)
  | { type: "usage_update"; usage: TokenUsage };

/**
 * Streaming configuration - controls HOW content is streamed
 * All fields optional with sensible defaults
 */
export interface StreamingConfig {
  /**
   * Enable streaming mode
   * - true: Always stream
   * - false: Never stream
   * - "auto": Auto-detect based on TTY (default)
   */
  readonly enabled: boolean | "auto";

  /**
   * Text buffer delay in milliseconds
   * Batches small chunks for smoother rendering
   * Only applies when streaming is enabled
   * Default: 50
   */
  readonly textBufferMs: number;
}

/**
 * Result of streaming operation
 */
export interface StreamingResult {
  /**
   * The event stream
   * Consumers process this stream for real-time updates
   */
  readonly stream: Stream.Stream<StreamEvent, LLMError>;

  /**
   * Effect that completes with final response
   * Consumers can either:
   * 1. Process the stream for real-time updates
   * 2. Just await the response for final result
   */
  readonly response: Effect.Effect<ChatCompletionResponse, LLMError>;

  /**
   * Cancel/abort the streaming operation
   * Uses AbortSignal internally to cancel the AI SDK request
   */
  readonly cancel: Effect.Effect<void, never>;
}

/**
 * Default streaming configuration
 */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  enabled: true,
  textBufferMs: 30,
};
