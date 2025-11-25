/**
 * Stream Processing Utilities
 *
 * Clean separation of concerns for AI SDK streaming:
 * - Handles AI SDK StreamText responses
 * - Emits Effect Stream events
 * - Manages completion signals
 * - Tracks reasoning and text streams
 */

import type { streamText } from "ai";
import { Chunk, Effect, Option } from "effect";
import type { LoggerService } from "../../core/interfaces/logger";
import { type LLMError } from "../../core/types/errors";
import type { ToolCall } from "../../core/types/tools";
import { type ChatCompletionResponse } from "./chat";
import type { StreamEvent } from "./streaming-types";

/**
 * Type for AI SDK StreamText result
 */
type StreamTextResult = ReturnType<typeof streamText>;

/**
 * Emit function type for Effect streams
 */
type EmitFunction = (
  effect: Effect.Effect<Chunk.Chunk<StreamEvent>, Option.Option<LLMError>>,
) => void;

/**
 * Configuration for stream processor
 */
interface StreamProcessorConfig {
  readonly providerName: string;
  readonly modelName: string;
  readonly hasReasoningEnabled: boolean;
  readonly startTime: number;
}

/**
 * Stream processor state
 */
interface StreamProcessorState {
  // Text accumulation
  accumulatedText: string;
  textSequence: number;
  hasStartedText: boolean;

  // Reasoning tracking
  reasoningSequence: number;
  reasoningTokens: number | undefined;
  reasoningStreamCompleted: boolean;

  // Tool calls
  collectedToolCalls: ToolCall[];

  // Timing
  firstTokenTime: number | null;
  firstTextTime: number | null;
  firstReasoningTime: number | null;

  // Completion tracking
  finishEventReceived: boolean;
  finishReason: string | undefined;
}

/**
 * Create initial processor state
 */
function createInitialState(): StreamProcessorState {
  return {
    accumulatedText: "",
    textSequence: 0,
    hasStartedText: false,
    reasoningSequence: 0,
    reasoningTokens: undefined,
    reasoningStreamCompleted: false,
    collectedToolCalls: [],
    firstTokenTime: null,
    firstTextTime: null,
    firstReasoningTime: null,
    finishEventReceived: false,
    finishReason: undefined,
  };
}

/**
 * Stream Processor
 * Handles AI SDK streaming responses and emits Effect stream events
 */
export class StreamProcessor {
  private state: StreamProcessorState;
  private completionResolver: (() => void) | null = null;
  private completionPromise: Promise<void>;

  constructor(
    private readonly config: StreamProcessorConfig,
    private readonly emit: EmitFunction,
    private readonly logger: LoggerService,
  ) {
    this.state = createInitialState();

    // Create completion promise
    this.completionPromise = new Promise<void>((resolve) => {
      this.completionResolver = resolve;
    });
  }

  /**
   * Get the completion promise
   */
  get completion(): Promise<void> {
    return this.completionPromise;
  }

  /**
   * Process AI SDK StreamText result
   * Returns the final ChatCompletionResponse
   */
  async process(result: StreamTextResult): Promise<ChatCompletionResponse> {
    // Emit stream start
    void this.emitEvent({
      type: "stream_start",
      provider: this.config.providerName,
      model: this.config.modelName,
      timestamp: this.config.startTime,
    });

    // Start processing stream
    void this.logger.debug(`[LLM Timing] 🔄 Starting to process fullStream...`);
    const streamProcessStart = Date.now();
    await this.processFullStream(result);
    void this.logger.debug(
      `[LLM Timing] ✓ Stream processing completed in ${Date.now() - streamProcessStart}ms`,
    );

    // Wait for completion
    await this.completionPromise;

    // Validate that we received finish event
    if (!this.state.finishEventReceived) {
      const error = new Error("Stream completed without finish event");
      throw error;
    }

    // Build final response
    const finalResponse = await this.buildFinalResponse(result);

    // Emit complete event
    this.emitCompleteEvent(finalResponse);

    return finalResponse;
  }

  /**
   * Process full stream for all events (text, reasoning, tools)
   */
  private async processFullStream(result: StreamTextResult): Promise<void> {
    try {
      for await (const part of result.fullStream) {
        // Stop if we've finished
        if (this.state.finishEventReceived) {
          break;
        }

        switch (part.type) {
          case "text-delta": {
            const textChunk = part.text;

            // Emit text start on first chunk
            if (!this.state.hasStartedText && textChunk.length > 0) {
              const firstTokenLatency = Date.now() - this.config.startTime;
              void this.logger.debug(
                `[LLM Timing] 🎯 FIRST TOKEN arrived after ${firstTokenLatency}ms`,
              );
              void this.emitEvent({ type: "text_start" });
              this.state.hasStartedText = true;
              this.recordFirstToken("text");
            }

            // Emit text chunk
            if (textChunk.length > 0) {
              this.state.accumulatedText += textChunk;
              void this.emitEvent({
                type: "text_chunk",
                delta: textChunk,
                accumulated: this.state.accumulatedText,
                sequence: this.state.textSequence++,
              });
            }
            break;
          }

          case "reasoning-delta": {
            if (!this.config.hasReasoningEnabled) {
              break;
            }

            const textDelta = part.text;

            if (textDelta && textDelta.length > 0) {
              // Emit thinking start if this is the first reasoning chunk
              if (this.state.reasoningSequence === 0) {
                const firstReasoningLatency = Date.now() - this.config.startTime;
                void this.logger.debug(
                  `[LLM Timing] 🧠 FIRST REASONING TOKEN arrived after ${firstReasoningLatency}ms`,
                );
                void this.emitEvent({ type: "thinking_start", provider: this.config.providerName });
                this.recordFirstToken("reasoning");
              }

              void this.emitEvent({
                type: "thinking_chunk",
                content: textDelta,
                sequence: this.state.reasoningSequence++,
              });
            }
            break;
          }

          case "reasoning-end": {
            // Extract reasoning tokens from metadata
            const totalUsage = "totalUsage" in part ? part.totalUsage : undefined;
            const usage = "usage" in part ? part.usage : undefined;

            const reasoningTokens =
              totalUsage && typeof totalUsage === "object" && "reasoningTokens" in totalUsage
                ? (totalUsage as { reasoningTokens?: number }).reasoningTokens
                : usage && typeof usage === "object" && "reasoningTokens" in usage
                  ? (usage as { reasoningTokens?: number }).reasoningTokens
                  : undefined;

            if (reasoningTokens !== undefined) {
              this.state.reasoningTokens = reasoningTokens;
            }

            // Emit thinking complete
            if (
              this.config.hasReasoningEnabled &&
              this.state.reasoningSequence > 0 &&
              !this.state.reasoningStreamCompleted
            ) {
              this.state.reasoningStreamCompleted = true;
              void this.emitEvent({
                type: "thinking_complete",
                ...(this.state.reasoningTokens !== undefined && {
                  totalTokens: this.state.reasoningTokens,
                }),
              });
            }
            break;
          }

          case "tool-call": {
            const toolCall: ToolCall = {
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            };
            this.state.collectedToolCalls.push(toolCall);

            void this.emitEvent({
              type: "tool_call",
              toolCall,
              sequence: this.state.textSequence++,
            });
            break;
          }

          case "finish": {
            const finishReason = part.finishReason || "unknown";
            this.state.finishEventReceived = true;
            this.state.finishReason = finishReason;

            // Validate expected finish reasons
            if (
              finishReason !== "stop" &&
              finishReason !== "length" &&
              finishReason !== "tool-calls"
            ) {
              console.warn(`[StreamProcessor] Unexpected finish reason: ${finishReason}`);
            }
            break;
          }

          case "error": {
            throw part.error;
          }
        }
      }
    } finally {
      this.resolveCompletion();
    }
  }

  /**
   * Build final response
   */
  private async buildFinalResponse(result: StreamTextResult): Promise<ChatCompletionResponse> {
    const finalText = this.state.accumulatedText;
    const toolCalls =
      this.state.collectedToolCalls.length > 0 ? this.state.collectedToolCalls : undefined;

    // Try to get usage quickly (50ms timeout)
    let usage: ChatCompletionResponse["usage"] | undefined;
    try {
      const usageResult = await Promise.race([
        result.usage,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
      ]);

      if (usageResult) {
        usage = {
          promptTokens: usageResult.inputTokens ?? 0,
          completionTokens: usageResult.outputTokens ?? 0,
          totalTokens: usageResult.totalTokens ?? 0,
        };

        // Emit usage update
        void this.emitEvent({ type: "usage_update", usage });
      }
    } catch {
      // Ignore usage errors
    }

    return {
      id: "",
      model: this.config.modelName,
      content: finalText,
      ...(toolCalls && { toolCalls }),
      ...(usage && { usage }),
    };
  }

  /**
   * Emit complete event with metrics
   */
  private emitCompleteEvent(response: ChatCompletionResponse): void {
    const endTime = Date.now();
    const totalDurationMs = endTime - this.config.startTime;

    let metrics:
      | {
          firstTokenLatencyMs: number;
          firstTextLatencyMs?: number;
          firstReasoningLatencyMs?: number;
          tokensPerSecond?: number;
          totalTokens?: number;
        }
      | undefined;

    if (this.state.firstTokenTime) {
      const firstTokenLatencyMs = this.state.firstTokenTime - this.config.startTime;
      metrics = { firstTokenLatencyMs };

      if (this.state.firstTextTime) {
        metrics.firstTextLatencyMs = this.state.firstTextTime - this.config.startTime;
      }

      if (this.state.firstReasoningTime) {
        metrics.firstReasoningLatencyMs = this.state.firstReasoningTime - this.config.startTime;
      }

      if (response.usage?.totalTokens) {
        metrics.tokensPerSecond = (response.usage.totalTokens / totalDurationMs) * 1000;
        metrics.totalTokens = response.usage.totalTokens;
      }
    }

    this.emitEvent({
      type: "complete",
      response,
      totalDurationMs,
      ...(metrics && { metrics }),
    });
  }

  /**
   * Record first token time
   */
  private recordFirstToken(type: "text" | "reasoning"): void {
    const now = Date.now();
    if (!this.state.firstTokenTime) {
      this.state.firstTokenTime = now;
    }

    if (type === "text" && !this.state.firstTextTime) {
      this.state.firstTextTime = now;
    } else if (type === "reasoning" && !this.state.firstReasoningTime) {
      this.state.firstReasoningTime = now;
    }
  }

  /**
   * Resolve completion
   */
  private resolveCompletion(): void {
    if (this.completionResolver) {
      this.completionResolver();
      this.completionResolver = null;
    }
  }

  /**
   * Emit a stream event
   */
  private emitEvent(event: StreamEvent): void {
    this.emit(Effect.succeed(Chunk.of(event)));
  }

  /**
   * Close the stream
   */
  close(): void {
    // Signal end of stream
    this.emit(Effect.fail(Option.none()));
  }
}
