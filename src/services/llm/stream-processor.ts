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
import type { StreamEvent } from "./streaming-types";
import type { ChatCompletionResponse, LLMError, ToolCall } from "./types";

/**
 * Type for AI SDK StreamText result
 */
type StreamTextResult = ReturnType<typeof streamText>;

/**
 * Emit function type for Effect streams
 */
type EmitFunction = (effect: Effect.Effect<Chunk.Chunk<StreamEvent>, Option.Option<LLMError>>) => void;

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
  textStreamCompleted: boolean;
  hasStartedText: boolean;

  // Reasoning tracking
  reasoningSequence: number;
  reasoningStreamCompleted: boolean;
  hasStartedReasoning: boolean;
  thinkingCompleteEmitted: boolean;
  reasoningTokens: number | undefined;

  // Tool calls
  collectedToolCalls: ToolCall[];

  // Timing
  firstTokenTime: number | null;

  // Completion tracking
  finishEventReceived: boolean;
}

/**
 * Create initial processor state
 */
function createInitialState(): StreamProcessorState {
  return {
    accumulatedText: "",
    textSequence: 0,
    textStreamCompleted: false,
    hasStartedText: false,
    reasoningSequence: 0,
    reasoningStreamCompleted: false,
    hasStartedReasoning: false,
    thinkingCompleteEmitted: false,
    reasoningTokens: undefined,
    collectedToolCalls: [],
    firstTokenTime: null,
    finishEventReceived: false,
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

    // Start processing streams in parallel
    await Promise.all([
      this.processTextStream(result),
      this.processReasoningText(result),
      this.processFullStream(result),
    ]);

    // Wait for completion
    await this.completionPromise;

    // Build final response
    const finalResponse = await this.buildFinalResponse(result);

    // Emit complete event
    this.emitCompleteEvent(finalResponse);

    return finalResponse;
  }

  /**
   * Process text stream
   */
  private async processTextStream(result: StreamTextResult): Promise<void> {
    try {
      for await (const textChunk of result.textStream) {
        // Emit text start on first chunk
        if (!this.state.hasStartedText && textChunk.length > 0) {
          void this.emitEvent({ type: "text_start" });
          this.state.hasStartedText = true;
          this.recordFirstToken();
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
      }
    } catch {
      // Handle stream errors gracefully
    } finally {
      this.state.textStreamCompleted = true;
      this.checkCompletion();
    }
  }

  /**
   * Process reasoning text (for reasoning models)
   */
  private async processReasoningText(result: StreamTextResult): Promise<void> {
    if (!this.config.hasReasoningEnabled) {
      this.state.reasoningStreamCompleted = true;
      return;
    }

    try {
      // Wait for reasoning text with timeout
      const reasoningText = await Promise.race([
        result.reasoningText,
        new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 30 * 60 * 1000)),
      ]);

      // Only emit if we have reasoning content
      if (reasoningText && reasoningText.length > 0) {
        // Emit thinking start
        if (!this.state.hasStartedReasoning) {
          void this.emitEvent({ type: "thinking_start", provider: this.config.providerName });
          this.state.hasStartedReasoning = true;
          this.recordFirstToken();
        }

        // Emit reasoning chunks
        const chunkSize = 1000;
        for (let i = 0; i < reasoningText.length; i += chunkSize) {
          const chunk = reasoningText.slice(i, i + chunkSize);
          void this.emitEvent({
            type: "thinking_chunk",
            content: chunk,
            sequence: this.state.reasoningSequence++,
          });
        }

        // Emit thinking complete
        if (!this.state.thinkingCompleteEmitted) {
          void this.emitEvent({
            type: "thinking_complete",
            ...(this.state.reasoningTokens !== undefined && { totalTokens: this.state.reasoningTokens }),
          });
          this.state.thinkingCompleteEmitted = true;
        }
      }
    } catch {
      // Silently handle reasoning errors - they shouldn't block the main response
    } finally {
      this.state.reasoningStreamCompleted = true;
      this.checkCompletion();
    }
  }

  /**
   * Process full stream for tool calls and metadata
   */
  private async processFullStream(result: StreamTextResult): Promise<void> {
    for await (const part of result.fullStream) {
        // Stop if we've finished
        if (this.state.finishEventReceived) {
          break;
        }

        switch (part.type) {
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
            break;
          }

          case "finish": {
            this.state.finishEventReceived = true;
            // For non-reasoning models, resolve immediately
            // For reasoning models, wait for reasoning text to complete
            if (!this.config.hasReasoningEnabled) {
              this.resolveCompletion();
            }
            break;
          }

          case "error": {
            throw part.error;
          }

          // Ignore other event types (text-delta, text-start, etc.) - handled by textStream
          default:
            break;
        }
    }
  }

  /**
   * Build final response
   */
  private async buildFinalResponse(result: StreamTextResult): Promise<ChatCompletionResponse> {
    const finalText = this.state.accumulatedText;
    const toolCalls = this.state.collectedToolCalls.length > 0 ? this.state.collectedToolCalls : undefined;

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
          tokensPerSecond?: number;
          totalTokens?: number;
        }
      | undefined;

    if (this.state.firstTokenTime) {
      const firstTokenLatencyMs = this.state.firstTokenTime - this.config.startTime;
      metrics = { firstTokenLatencyMs };

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
  private recordFirstToken(): void {
    if (!this.state.firstTokenTime) {
      this.state.firstTokenTime = Date.now();
    }
  }

  /**
   * Check if we can resolve completion
   */
  private checkCompletion(): void {
    // For reasoning models: wait for both text and reasoning streams
    // For non-reasoning models: wait for text stream only
    if (this.config.hasReasoningEnabled) {
      if (this.state.textStreamCompleted && this.state.reasoningStreamCompleted) {
        this.resolveCompletion();
      }
    } else {
      if (this.state.textStreamCompleted) {
        this.resolveCompletion();
      }
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

