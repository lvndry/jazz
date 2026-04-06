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
import type { LoggerService } from "@/core/interfaces/logger";
import type { ChatCompletionResponse, StreamEvent } from "@/core/types";
import { type LLMError } from "@/core/types/errors";
import type { ToolCall } from "@/core/types/tools";
import { parseLlamaCppRawToolCalls } from "@/core/utils/llamacpp-tool-parser";

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
  readonly toolsDisabled?: boolean;
  readonly providerNativeToolNames?: Set<string>;
  /** Estimated character count of tool definitions for telemetry. */
  readonly toolDefinitionChars?: number;
  /** Number of tool definitions sent to the LLM. */
  readonly toolDefinitionCount?: number;
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
  /** Provider-native tool calls waiting for tool-result to arrive with enriched data (e.g. query) */
  pendingNativeToolCalls: Map<string, { toolCall: ToolCall; sequence: number }>;

  // Timing
  firstTokenTime: number | null;
  firstTextTime: number | null;
  firstReasoningTime: number | null;

  // Completion tracking
  finishEventReceived: boolean;
  finishReason: string | undefined;

  // Interruption
  cancelled: boolean;

  /**
   * Buffer for raw tool-call tokens that llama-server leaks as plain text.
   * When we see an opening sentinel (e.g. "<|tool_call>") we accumulate the
   * delta chunks here instead of emitting them to the UI.  Once a closing
   * sentinel is seen we parse the buffer and suppress it from the display;
   * if parsing fails we flush the buffer as normal text.
   */
  rawToolCallBuffer: string | null;
}

/**
 * Raw tool-call opening / closing sentinels we need to watch for in streaming
 * text deltas so we can suppress them from the display.
 *
 * Order matters: put longer/more specific patterns first to avoid false matches.
 */
const RAW_TOOL_CALL_OPEN = "<|tool_call>";
const RAW_TOOL_CALL_CLOSE = "<tool_call|>";
const LLAMA_TOOL_CALL_OPEN = "[TOOL_CALLS]";
const QWEN_TOOL_CALL_OPEN = "<tool_call>";
const QWEN_TOOL_CALL_CLOSE = "</tool_call>";

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
    pendingNativeToolCalls: new Map(),
    firstTokenTime: null,
    firstTextTime: null,
    firstReasoningTime: null,
    finishEventReceived: false,
    finishReason: undefined,
    cancelled: false,
    rawToolCallBuffer: null,
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
   * Signal that the stream has been cancelled externally
   */
  cancel(): void {
    this.state.cancelled = true;
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
    if (!this.state.finishEventReceived && !this.state.cancelled) {
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
            let textChunk: string;
            if (typeof part.text === "string") {
              textChunk = part.text;
            } else if (Array.isArray(part.text)) {
              // Extract text from structured content array
              // e.g Mistral may return content as array of objects or strings
              const textArray = part.text as Array<unknown>;
              textChunk = textArray
                .map((item: unknown) => {
                  if (typeof item === "object" && item !== null) {
                    const itemData = item as Record<string, unknown>;
                    if (itemData["type"] === "text" && "text" in itemData) {
                      return String(itemData["text"]);
                    }
                    if (itemData["type"] === "reference") {
                      // Skip reference items for now, could be enhanced to handle citations
                      return "";
                    }
                  }
                  return typeof item === "string" ? item : "";
                })
                .join("");
            } else {
              // Fallback: convert to string
              textChunk = String(part.text ?? "");
            }

            // Always accumulate the raw chunk first so buildFinalResponse has
            // the full text (including any raw tool-call tokens) for parsing.
            if (textChunk.length > 0) {
              this.state.accumulatedText += textChunk;
            }

            // For llamacpp: strip raw tool-call token sequences from the live
            // display so they don't flicker on-screen during streaming.
            // Accumulation above is unaffected — buildFinalResponse will parse
            // and strip them from the final content after the stream ends.
            let displayChunk = textChunk;
            if (this.config.providerName === "llamacpp" && textChunk.length > 0) {
              displayChunk = this.filterLlamaCppRawToolCallChunk(textChunk);
            }

            // Emit text start on first visible chunk
            if (!this.state.hasStartedText && displayChunk.length > 0) {
              const firstTokenLatency = Date.now() - this.config.startTime;
              void this.logger.debug(
                `[LLM Timing] 🎯 FIRST TOKEN arrived after ${firstTokenLatency}ms`,
              );
              void this.emitEvent({ type: "text_start" });
              this.state.hasStartedText = true;
              this.recordFirstToken("text");
            }

            // Emit text chunk (display-filtered delta, raw accumulated text)
            if (displayChunk.length > 0) {
              void this.emitEvent({
                type: "text_chunk",
                delta: displayChunk,
                accumulated: this.state.accumulatedText,
                sequence: this.state.textSequence++,
              });
            }
            break;
          }

          case "reasoning-start": {
            // Handle reasoning start event (emitted before reasoning-delta chunks)
            if (!this.config.hasReasoningEnabled) {
              break;
            }

            // Emit thinking start on reasoning-start event
            if (this.state.reasoningSequence === 0) {
              const firstReasoningLatency = Date.now() - this.config.startTime;
              void this.logger.debug(
                `[LLM Timing] 🧠 REASONING START arrived after ${firstReasoningLatency}ms`,
              );
              void this.emitEvent({ type: "thinking_start", provider: this.config.providerName });
              this.recordFirstToken("reasoning");
            }
            break;
          }

          case "reasoning-delta": {
            if (!this.config.hasReasoningEnabled) {
              break;
            }

            const textDelta = part.text;

            if (textDelta && textDelta.length > 0) {
              // Emit thinking start if we haven't received reasoning-start event
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

              this.state.reasoningSequence = 0;
              this.state.reasoningStreamCompleted = false;
            }
            break;
          }

          case "tool-call": {
            const isProviderNative =
              this.config.providerNativeToolNames?.has(part.toolName) ?? false;

            const toolCall: ToolCall = {
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            };

            // Preserve thought_signature for Google/Gemini models if present
            // The AI SDK includes it in providerMetadata.google.thoughtSignature
            if ("providerMetadata" in part && part.providerMetadata) {
              const providerMetadata = part.providerMetadata as {
                google?: { thoughtSignature?: string };
              };
              if (providerMetadata?.google?.thoughtSignature) {
                toolCall.thought_signature = providerMetadata.google.thoughtSignature;
              }
            }

            if (isProviderNative) {
              // Buffer provider-native tool calls (e.g. OpenAI web_search).
              // The AI SDK hardcodes empty input for these; the real data (e.g.
              // search query) arrives in the subsequent tool-result event.
              // We wait for tool-result to emit a single, complete tool_call.
              this.state.pendingNativeToolCalls.set(toolCall.id, {
                toolCall,
                sequence: this.state.textSequence++,
              });
            } else {
              void this.emitEvent({
                type: "tool_call",
                toolCall,
                sequence: this.state.textSequence++,
              });
              this.state.collectedToolCalls.push(toolCall);
            }
            break;
          }

          // Provider-native tool results (e.g. OpenAI web_search).
          // The AI SDK emits tool-result after tool-call for provider-executed tools.
          // For web_search the query is NOT in tool-call input (hardcoded {})
          // but IS in tool-result output as action.query.
          case "tool-result": {
            const pending = this.state.pendingNativeToolCalls.get(part.toolCallId);
            if (!pending) break;
            this.state.pendingNativeToolCalls.delete(part.toolCallId);

            // Enrich the buffered tool call with data from the result
            const output = part.output as Record<string, unknown> | undefined;
            const action = output?.["action"] as Record<string, unknown> | undefined;
            if (action?.["type"] === "search" && typeof action["query"] === "string") {
              pending.toolCall.function.arguments = JSON.stringify({ query: action["query"] });
            }

            void this.emitEvent({
              type: "tool_call",
              toolCall: pending.toolCall,
              sequence: pending.sequence,
              providerNative: true,
            });
            break;
          }

          case "finish": {
            // Flush any buffered provider-native tool calls that never got a tool-result
            for (const [id, pending] of this.state.pendingNativeToolCalls) {
              void this.emitEvent({
                type: "tool_call",
                toolCall: pending.toolCall,
                sequence: pending.sequence,
                providerNative: true,
              });
              this.state.pendingNativeToolCalls.delete(id);
            }

            const finishReason = part.finishReason || "unknown";
            this.state.finishEventReceived = true;
            this.state.finishReason = finishReason;

            // Handle error finish reason
            if (finishReason === "error") {
              const error = new Error(
                `Unexpected error during stream processing: ${JSON.stringify(part)}`,
              );
              throw error;
            }

            if (
              finishReason !== "stop" &&
              finishReason !== "length" &&
              finishReason !== "tool-calls"
            ) {
              void this.logger.warn(`[StreamProcessor] Unexpected finish reason: ${finishReason}`);
            }
            break;
          }

          case "error": {
            throw part.error;
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AI_TypeValidationError") {
        void this.logger.warn(
          `[StreamProcessor] AI SDK validation error (likely due to provider-specific content format): ${error.message}`,
          {
            provider: this.config.providerName,
            model: this.config.modelName,
            errorName: error.name,
          },
        );

        throw error;
      }
      // Re-throw other errors
      throw error;
    } finally {
      this.resolveCompletion();
    }
  }

  /**
   * Build final response
   */
  private async buildFinalResponse(result: StreamTextResult): Promise<ChatCompletionResponse> {
    let finalText = this.state.accumulatedText;
    let toolCalls: ToolCall[] | undefined =
      this.state.collectedToolCalls.length > 0 ? this.state.collectedToolCalls : undefined;

    // llamacpp fallback: llama-server sometimes leaks the model's native tool-call
    // tokens as plain text instead of returning structured function calls.
    // Parse them out and strip them from the final content.
    if (this.config.providerName === "llamacpp" && (!toolCalls || toolCalls.length === 0)) {
      const parsed = parseLlamaCppRawToolCalls(finalText);
      if (parsed) {
        toolCalls = parsed.toolCalls;
        finalText = parsed.cleanText;
      }
    }

    let usage: ChatCompletionResponse["usage"];
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
          ...(this.state.reasoningTokens !== undefined && {
            reasoningTokens: this.state.reasoningTokens,
          }),
          ...(usageResult.outputTokenDetails?.reasoningTokens != null &&
            this.state.reasoningTokens === undefined && {
              reasoningTokens: usageResult.outputTokenDetails.reasoningTokens,
            }),
          ...(usageResult.inputTokenDetails?.cacheReadTokens != null && {
            cacheReadTokens: usageResult.inputTokenDetails.cacheReadTokens,
          }),
          ...(usageResult.inputTokenDetails?.cacheWriteTokens != null && {
            cacheWriteTokens: usageResult.inputTokenDetails.cacheWriteTokens,
          }),
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
      ...(this.config.toolsDisabled ? { toolsDisabled: true } : {}),
      ...(this.config.toolDefinitionChars != null
        ? { toolDefinitionChars: this.config.toolDefinitionChars }
        : {}),
      ...(this.config.toolDefinitionCount != null
        ? { toolDefinitionCount: this.config.toolDefinitionCount }
        : {}),
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
   * Filter raw tool-call token sequences from a llamacpp streaming text chunk.
   *
   * When we encounter an opening sentinel (e.g. "<|tool_call>") we start
   * buffering into `state.rawToolCallBuffer` and return an empty string so
   * nothing is emitted to the display.  When the matching closing sentinel
   * arrives we clear the buffer (the tokens are later parsed by
   * buildFinalResponse) and return an empty string.  Everything before the
   * opening and after the closing is passed through normally.
   *
   * Note: the raw tokens are still accumulated into `state.accumulatedText`
   * by the caller (they pass through via the standard path only for non-tool-
   * call text).  For tool-call segments we deliberately keep them OUT of
   * accumulatedText as well, because buildFinalResponse uses
   * parseLlamaCppRawToolCalls on the accumulated text and then strips them.
   * To keep things simple we let buildFinalResponse do the stripping on the
   * full accumulated text; we just avoid emitting them to the UI.
   */
  private filterLlamaCppRawToolCallChunk(chunk: string): string {
    // Fast path: nothing buffered and no sentinel present.
    const openers = [RAW_TOOL_CALL_OPEN, LLAMA_TOOL_CALL_OPEN, QWEN_TOOL_CALL_OPEN];
    if (this.state.rawToolCallBuffer === null && !openers.some((o) => chunk.includes(o))) {
      return chunk;
    }

    let result = "";
    let remaining = chunk;

    // If we're already buffering, append to buffer and look for a close.
    if (this.state.rawToolCallBuffer !== null) {
      this.state.rawToolCallBuffer += remaining;
      remaining = "";

      // Check for Gemma close
      if (this.state.rawToolCallBuffer.includes(RAW_TOOL_CALL_CLOSE)) {
        // Everything after the close can be returned as normal text.
        const closeIdx =
          this.state.rawToolCallBuffer.indexOf(RAW_TOOL_CALL_CLOSE) + RAW_TOOL_CALL_CLOSE.length;
        result += this.state.rawToolCallBuffer.slice(closeIdx);
        this.state.rawToolCallBuffer = null;
        return result.trimStart();
      }

      // Check for Llama/Mistral — the whole pattern is on one line typically
      if (
        this.state.rawToolCallBuffer.startsWith(LLAMA_TOOL_CALL_OPEN) &&
        this.state.rawToolCallBuffer.includes("]")
      ) {
        // Find the last ']' which closes the JSON array.
        const lastBracket = this.state.rawToolCallBuffer.lastIndexOf("]");
        result += this.state.rawToolCallBuffer.slice(lastBracket + 1);
        this.state.rawToolCallBuffer = null;
        return result.trimStart();
      }

      // Check for Qwen XML close
      if (this.state.rawToolCallBuffer.includes(QWEN_TOOL_CALL_CLOSE)) {
        const closeIdx =
          this.state.rawToolCallBuffer.indexOf(QWEN_TOOL_CALL_CLOSE) + QWEN_TOOL_CALL_CLOSE.length;
        result += this.state.rawToolCallBuffer.slice(closeIdx);
        this.state.rawToolCallBuffer = null;
        return result.trimStart();
      }

      // Still incomplete — keep buffering, emit nothing.
      return "";
    }

    // Not currently buffering. Scan for an opener in the remaining text.
    for (const opener of openers) {
      const openIdx = remaining.indexOf(opener);
      if (openIdx !== -1) {
        // Pass through everything BEFORE the opener.
        result += remaining.slice(0, openIdx);
        // Start buffering from the opener.
        this.state.rawToolCallBuffer = remaining.slice(openIdx);
        remaining = "";

        // Immediately check if the closing sentinel is also in this chunk.
        const closer =
          opener === RAW_TOOL_CALL_OPEN
            ? RAW_TOOL_CALL_CLOSE
            : opener === QWEN_TOOL_CALL_OPEN
              ? QWEN_TOOL_CALL_CLOSE
              : null;

        if (closer && this.state.rawToolCallBuffer.includes(closer)) {
          const closeIdx = this.state.rawToolCallBuffer.indexOf(closer) + closer.length;
          result += this.state.rawToolCallBuffer.slice(closeIdx);
          this.state.rawToolCallBuffer = null;
        } else if (opener === LLAMA_TOOL_CALL_OPEN) {
          // Llama format is typically a single line; look for closing ']'
          const lastBracket = this.state.rawToolCallBuffer.lastIndexOf("]");
          if (lastBracket !== -1) {
            result += this.state.rawToolCallBuffer.slice(lastBracket + 1);
            this.state.rawToolCallBuffer = null;
          }
        }

        return result;
      }
    }

    return result + remaining;
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
