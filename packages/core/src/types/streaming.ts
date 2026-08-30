import { Effect, Stream } from "effect";
import type { ChatCompletionResponse } from "./chat";
import type { LLMError } from "./errors";
import type { ToolCall, ApprovalOption } from "./tools";

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
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
      /**
       * `num_ctx` sent to a local server for this request. It is the window the
       * server will honour, so consumers showing context usage must prefer it
       * over the model's advertised maximum.
       */
      pinnedContextWindow?: number;
    }
  | {
      type: "complete";
      response: ChatCompletionResponse;
      totalDurationMs: number;
      /**
       * Performance metrics (only included if output.showMetrics is enabled)
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
  | { type: "tool_call"; toolCall: ToolCall; sequence: number; providerNative?: boolean }
  | {
      type: "tools_detected";
      toolNames: readonly string[];
      toolsRequiringApproval: readonly string[];
      agentName: string;
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      arguments?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      /** If true, the tool is expected to take a long time (skip timeout warning) */
      longRunning?: boolean;
    }
  | {
      type: "tool_execution_complete";
      toolCallId: string;
      result: string;
      durationMs: number;
      summary?: string;
      /** Absent means success (backward compatibility with older emitters). */
      success?: boolean;
      /** Human-readable failure reason; set when success is false. */
      error?: string;
      /**
       * Set when `execute_command` ran the risk classifier. The token is the
       * verdict that decided whether this call was auto-approved.
       */
      classifiedRisk?: string;
    }

  // Usage updates (optional, for real-time token tracking)
  | { type: "usage_update"; usage: TokenUsage }

  // Tool approval flow (headless consumers can surface gated/declined tools)
  | {
      type: "command_risk_classifying";
      toolCallId: string;
      toolName: string;
      command: string;
    }
  | {
      type: "command_risk_classified";
      toolCallId: string;
      toolName: string;
      command: string;
      riskLevel: string;
      autoApproved: boolean;
    }
  | {
      type: "approval_required";
      toolCallId: string;
      toolName: string;
      message: string;
      previewDiff?: string;
      /** Picker-style approval: the rows a surface should offer instead of yes/no. */
      options?: readonly ApprovalOption[];
      riskLevel?: string;
      autoApprovePolicy?: string;
    }
  | {
      type: "approval_resolved";
      toolCallId: string;
      toolName: string;
      approved: boolean;
      auto: boolean;
    }

  // Sub-agent lifecycle (delegated spawn_subagent runs)
  | { type: "subagent_start"; task?: string; agentName?: string }
  /**
   * Emitted whatever the outcome, so a consumer can close the bracket it opened on
   * `subagent_start`. It carries the sub-agent's own name because several run at once
   * and the event reaches the stream through the *parent's* renderer, which would
   * otherwise attribute it to the parent.
   */
  | { type: "subagent_complete"; agentName?: string; durationMs?: number }
  /** Structured result status emitted when spawn_subagent was called with resultSchema. */
  | {
      type: "subagent_result";
      subagentId: string;
      agentName?: string;
      durationMs: number;
      costUSD?: number;
      costKnown: boolean;
      structuredResult: {
        requested: true;
        valid: boolean;
        resultName?: string;
        errorCount?: number;
      };
    };

export interface StreamingResult {
  readonly stream: Stream.Stream<StreamEvent, LLMError>;
  readonly response: Effect.Effect<ChatCompletionResponse, LLMError>;
  readonly cancel: Effect.Effect<void, never>;
}

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
  readonly enabled?: boolean | "auto";

  /**
   * Text buffer delay in milliseconds
   * Batches small chunks for smoother rendering
   * Only applies when streaming is enabled
   * Default: 50
   */
  readonly textBufferMs?: number;
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
