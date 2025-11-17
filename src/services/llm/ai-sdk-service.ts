import { anthropic, AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google } from "@ai-sdk/google";
import { mistral } from "@ai-sdk/mistral";
import { openai, OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
import { ollama, OllamaCompletionProviderOptions } from "ollama-ai-provider-v2";

import {
  generateText,
  stepCountIs,
  streamText,
  tool,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolModelMessage,
  type ToolSet,
  type TypedToolCall,
  type UserModelMessage,
} from "ai";
import { Chunk, Effect, Layer, Option, Stream } from "effect";
import { z } from "zod";
import { MAX_AGENT_STEPS } from "../../constants/agent";
import { AgentConfigService, type ConfigService } from "../config";
import type { StreamEvent, StreamingResult } from "./streaming-types";
import {
  LLMAuthenticationError,
  LLMConfigurationError,
  LLMRateLimitError,
  LLMRequestError,
  LLMServiceTag,
  type ChatCompletionOptions,
  type ChatCompletionResponse,
  type LLMError,
  type LLMProvider,
  type LLMService,
  type ModelInfo,
  type ToolCall,
} from "./types";

interface AISDKConfig {
  apiKeys: Record<string, string>;
}

function safeParseJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toCoreMessages(
  messages: ReadonlyArray<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ReadonlyArray<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>,
): ModelMessage[] {
  return messages.map((m) => {
    const role = m.role;

    if (role === "system") {
      return {
        role: "system",
        content: m.content,
      } as SystemModelMessage;
    }

    // User messages - simple string content
    if (role === "user") {
      return {
        role: "user",
        content: m.content,
      } as UserModelMessage;
    }

    // Assistant messages (may include tool calls)
    if (role === "assistant") {
      const contentParts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];

      if (m.content && m.content.length > 0) {
        contentParts.push({ type: "text", text: m.content });
      }

      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          contentParts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: safeParseJson(tc.function.arguments),
          });
        }
      }

      // If we have content parts, return them as an array, otherwise return as string
      if (contentParts.length > 0) {
        return { role: "assistant", content: contentParts } as AssistantModelMessage;
      } else {
        return { role: "assistant", content: "" } as AssistantModelMessage;
      }
    }

    // Tool messages (tool results)
    if (role === "tool") {
      const contentParts: ToolModelMessage["content"] = [];

      contentParts.push({
        type: "tool-result",
        toolCallId: m.tool_call_id ?? "",
        toolName: m.name ?? "tool",
        output: { type: "text", value: m.content },
      });

      return { role: "tool", content: contentParts } as ToolModelMessage;
    }

    // Fallback - should not reach here
    throw new Error(`Unsupported message role: ${String(role)}`);
  });
}

type ModelName = string;

function selectModel(providerName: string, modelId: ModelName): LanguageModel {
  switch (providerName.toLowerCase()) {
    case "openai":
      return openai(modelId);
    case "anthropic":
      return anthropic(modelId);
    case "google":
      return google(modelId);
    case "mistral":
      return mistral(modelId);
    case "xai":
      return xai(modelId);
    case "deepseek":
      return (deepseek as (modelId: ModelName) => LanguageModel)(modelId);
    case "ollama":
      return ollama(modelId);
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }
}

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type ProviderOptions = Record<string, Record<string, JsonValue>>;

function buildProviderOptions(
  providerName: string,
  options: ChatCompletionOptions,
): ProviderOptions | undefined {
  const normalizedProvider = providerName.toLowerCase();

  switch (normalizedProvider) {
    case "openai": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        return {
          openai: {
            reasoningEffort,
          } satisfies OpenAIResponsesProviderOptions,
        };
      }
      break;
    }
    case "anthropic": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        return {
          anthropic: {
            thinking: { type: "enabled" },
          } satisfies AnthropicProviderOptions,
        };
      }
      break;
    }
    case "ollama": {
      if (options.reasoning_effort && options.reasoning_effort !== "disable") {
        return {
          ollama: {
            think: true,
          } satisfies OllamaCompletionProviderOptions,
        };
      }
      break;
    }
    default:
      break;
  }

  return undefined;
}

/**
 * Promise.withResolvers polyfill for older Node.js versions
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Convert error to LLMError
 */
function convertToLLMError(error: unknown, providerName: string): LLMError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  let httpStatus: number | undefined;

  if (error instanceof Error) {
    const e = error as Error & { status?: number; statusCode?: number };
    httpStatus = e.status || e.statusCode;
    if (!httpStatus) {
      const m = errorMessage.match(/(\d{3})\s/);
      if (m && m[1]) httpStatus = parseInt(m[1], 10);
    }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return new LLMAuthenticationError(providerName, errorMessage);
  } else if (httpStatus === 429) {
    return new LLMRateLimitError(providerName, errorMessage);
  } else if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return new LLMRequestError(providerName, errorMessage);
  } else if (httpStatus && httpStatus >= 500) {
    return new LLMRequestError(providerName, `Server error (${httpStatus}): ${errorMessage}`);
  } else {
    if (
      errorMessage.toLowerCase().includes("authentication") ||
      errorMessage.toLowerCase().includes("api key")
    ) {
      return new LLMAuthenticationError(providerName, errorMessage);
    } else {
      return new LLMRequestError(providerName, errorMessage || "Unknown LLM request error");
    }
  }
}

class DefaultAISDKService implements LLMService {
  private config: AISDKConfig;
  private providerModels: Record<string, ModelInfo[]>;

  constructor(config: AISDKConfig) {
    this.config = config;

    // Export API keys to env for providers that read from env
    Object.entries(this.config.apiKeys).forEach(([provider, apiKey]) => {
      process.env[`${provider.toUpperCase()}_API_KEY`] = apiKey;
    });

    this.providerModels = {
      openai: [
        { id: "gpt-5.1", displayName: "GPT-5.1", isReasoningModel: true },
        { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isReasoningModel: true },
        { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true },
        { id: "gpt-5-pro", displayName: "GPT-5 Pro", isReasoningModel: true },
        { id: "gpt-5-codex", displayName: "GPT-5 Codex", isReasoningModel: true },
        { id: "gpt-5-mini", displayName: "GPT-5 Mini", isReasoningModel: true },
        { id: "gpt-5-nano", displayName: "GPT-5 Nano", isReasoningModel: true },
        { id: "gpt-4.1", displayName: "GPT-4.1", isReasoningModel: true },
        { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", isReasoningModel: true },
        { id: "gpt-4.1-nano", displayName: "GPT-4.1 Nano", isReasoningModel: true },
        { id: "gpt-4o", displayName: "GPT-4o", isReasoningModel: false },
        { id: "gpt-4o-mini", displayName: "GPT-4o Mini", isReasoningModel: false },
        { id: "o4-mini", displayName: "o4-mini", isReasoningModel: true },
      ],
      anthropic: [
        { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isReasoningModel: true },
        { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isReasoningModel: true },
        { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", isReasoningModel: true },
      ],
      google: [
        { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", isReasoningModel: true },
        { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", isReasoningModel: true },
        {
          id: "gemini-2.5-flash-lite",
          displayName: "Gemini 2.5 Flash Lite",
          isReasoningModel: true,
        },
        { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", isReasoningModel: false },
      ],
      mistral: [
        { id: "mistral-small-latest", displayName: "Mistral Small", isReasoningModel: false },
        { id: "mistral-medium-latest", displayName: "Mistral Medium", isReasoningModel: false },
        { id: "mistral-large-latest", displayName: "Mistral Large", isReasoningModel: false },
        { id: "magistral-small-2506", displayName: "Magistral Small", isReasoningModel: true },
        { id: "magistral-medium-2506", displayName: "Magistral Medium", isReasoningModel: true },
      ],
      xai: [
        {
          id: "grok-4-fast-non-reasoning",
          displayName: "Grok 4 Fast (Non-Reasoning)",
          isReasoningModel: false,
        },
        {
          id: "grok-4-fast-reasoning",
          displayName: "Grok 4 Fast (Reasoning)",
          isReasoningModel: true,
        },
        { id: "grok-4", displayName: "Grok 4", isReasoningModel: false },
        { id: "grok-code-fast-1", displayName: "Grok 4 (0709)", isReasoningModel: true },
        { id: "grok-3", displayName: "Grok 3", isReasoningModel: true },
        { id: "grok-3-mini", displayName: "Grok 3 Mini", isReasoningModel: true },
      ],
      deepseek: [{ id: "deepseek-chat", displayName: "DeepSeek Chat", isReasoningModel: false }],
      ollama: [
        { id: "llama4", displayName: "Llama 4", isReasoningModel: false },
        { id: "llama3", displayName: "Llama 3", isReasoningModel: false },
        { id: "qwq", displayName: "QWQ", isReasoningModel: false },
        { id: "deepseek-r1", displayName: "DeepSeek R1", isReasoningModel: true },
      ],
    };
  }

  getProvider(
    providerName: keyof typeof this.providerModels,
  ): Effect.Effect<LLMProvider, LLMConfigurationError> {
    return Effect.try({
      try: () => {
        if (!this.providerModels[providerName]) {
          throw new LLMConfigurationError(providerName, `Provider not supported: ${providerName}`);
        }

        const provider: LLMProvider = {
          name: providerName,
          supportedModels: this.providerModels[providerName],
          defaultModel: this.providerModels[providerName][0]?.id ?? "",
          authenticate: () =>
            Effect.try({
              try: () => {
                const apiKey = this.config.apiKeys[providerName];
                if (!apiKey) {
                  throw new LLMAuthenticationError(providerName, "API key not configured");
                }
              },
              catch: (error: unknown) =>
                new LLMAuthenticationError(
                  providerName,
                  error instanceof Error ? error.message : String(error),
                ),
            }),
          createChatCompletion: (options) => this.createChatCompletion(providerName, options),
        };

        return provider;
      },
      catch: (error: unknown) =>
        new LLMConfigurationError(
          providerName,
          `Failed to get provider: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  }

  listProviders(): Effect.Effect<readonly string[], never> {
    const configuredProviders = Object.keys(this.config.apiKeys);
    const intersect = configuredProviders.filter((p) => this.providerModels[p]);
    return Effect.succeed(intersect);
  }

  createChatCompletion(
    providerName: string,
    options: ChatCompletionOptions,
  ): Effect.Effect<ChatCompletionResponse, LLMError> {
    return Effect.tryPromise({
      try: async () => {
        if (options.stream === true) {
          throw new Error("Streaming responses are not supported yet");
        }

        const model = selectModel(providerName, options.model);

        // Prepare tools for AI SDK if present
        let tools: ToolSet | undefined;
        if (options.tools && options.tools.length > 0) {
          tools = {};

          for (const toolDef of options.tools) {
            tools[toolDef.function.name] = tool({
              description: toolDef.function.description,
              inputSchema: toolDef.function.parameters as unknown as z.ZodTypeAny,
            });
          }
        }

        const providerOptions = buildProviderOptions(providerName, options);

        const result = await generateText({
          model,
          messages: toCoreMessages(options.messages),
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
          ...(tools ? { tools } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
        });

        let responseModel = options.model;
        let content = "";
        let toolCalls: ChatCompletionResponse["toolCalls"] | undefined = undefined;
        let usage: ChatCompletionResponse["usage"] | undefined = undefined;

        // Extract text content
        content = result.text ?? "";

        // Extract model ID from result (fallback to options.model if not available)
        responseModel = options.model; // AI SDK doesn't expose modelId in result

        // Extract usage information
        if (result.usage) {
          const usageData = result.usage;
          usage = {
            promptTokens: usageData.inputTokens ?? 0,
            completionTokens: usageData.outputTokens ?? 0,
            totalTokens: usageData.totalTokens ?? 0,
          };
        }

        // Extract tool calls if present
        if (result.toolCalls && result.toolCalls.length > 0) {
          toolCalls = result.toolCalls.map((tc: TypedToolCall<ToolSet>) => {
            // Handle both static and dynamic tool calls
            if ("dynamic" in tc && tc.dynamic) {
              // Dynamic tool call
              return {
                id: tc.toolCallId,
                type: "function" as const,
                function: {
                  name: tc.toolName,
                  arguments: JSON.stringify(tc.input ?? {}),
                },
              };
            } else {
              // Static tool call
              return {
                id: tc.toolCallId,
                type: "function" as const,
                function: {
                  name: tc.toolName,
                  arguments: JSON.stringify(tc.input ?? {}),
                },
              };
            }
          });
        }

        const resultObj: ChatCompletionResponse = {
          id: "",
          model: responseModel,
          content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
        };
        return resultObj;
      },
      catch: (error: unknown) => convertToLLMError(error, providerName),
    });
  }

  createStreamingChatCompletion(
    providerName: string,
    options: ChatCompletionOptions,
  ): Effect.Effect<StreamingResult, LLMError> {
    const model = selectModel(providerName, options.model);

    // Prepare tools for AI SDK if present
    let tools: ToolSet | undefined;
    if (options.tools && options.tools.length > 0) {
      tools = {};
      for (const toolDef of options.tools) {
        tools[toolDef.function.name] = tool({
          description: toolDef.function.description,
          inputSchema: toolDef.function.parameters as unknown as z.ZodTypeAny,
        });
      }
    }

    const providerOptions = buildProviderOptions(providerName, options);

    // Create AbortController for cancellation
    const abortController = new AbortController();

    // Create a deferred to collect final response
    const responseDeferred = createDeferred<ChatCompletionResponse>();

    // Create the stream - use Stream.async for async operations
    const stream = Stream.async<StreamEvent, LLMError>((emit) => {
      // Start async processing
      void (async (): Promise<void> => {
        const startTime = Date.now();
        let firstTokenTime: number | null = null;

        try {
          // Emit start event
          void emit(Effect.succeed(Chunk.of({
            type: "stream_start",
            provider: providerName,
            model: options.model,
            timestamp: startTime,
          })));

          const result = streamText({
            model,
            messages: toCoreMessages(options.messages),
            ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
            ...(tools ? { tools } : {}),
            ...(providerOptions ? { providerOptions } : {}),
            abortSignal: abortController.signal,
            stopWhen: stepCountIs(MAX_AGENT_STEPS),
          });

          let accumulatedText = "";
          let textSequence = 0;
          let reasoningSequence = 0;
          let hasStartedText = false;
          let hasStartedReasoning = false;

          // Track tool calls as they come in during streaming
          const collectedToolCalls: ToolCall[] = [];

          // Track reasoning tokens for later extraction from final usage
          let reasoningTokensFromUsage: number | undefined = undefined;
          let thinkingCompleteEmitted = false;
          // Track completion signals
          let finishEventReceived = false;
          const completionDeferred = createDeferred<void>();
          // Flag to stop processing fullStream after finish event
          let shouldStopFullStream = false;

          // Process textStream for text chunks - this is our primary completion signal
          const textStreamPromise = (async (): Promise<void> => {
            try {
              for await (const textChunk of result.textStream) {
                // Detect text-start: if hasStartedText = false and we get text
                if (!hasStartedText && textChunk.length > 0) {
                  void emit(Effect.succeed(Chunk.of({ type: "text_start" })));
                  hasStartedText = true;
                  // Record first token time on first content
                  if (!firstTokenTime) {
                    firstTokenTime = Date.now();
                  }
                }

                if (textChunk.length > 0) {
                  accumulatedText += textChunk;
                  void emit(Effect.succeed(Chunk.of({
                    type: "text_chunk",
                    delta: textChunk,
                    accumulated: accumulatedText,
                    sequence: textSequence++,
                  })));
                }
              }
              // textStream completed - this is the reliable completion signal
              completionDeferred.resolve();
            } catch (error) {
              // Handle textStream errors
              if (options.reasoning_effort && options.reasoning_effort !== "disable") {
                console.error(`Error in textStream:`, error);
              }
              // Resolve completion even on error - we may still have tool calls
              completionDeferred.resolve();
              throw error; // Re-throw to be caught by outer handler
            }
          })();

          // Process reasoningText Promise with timeout to avoid blocking
          const reasoningTextPromise = (async (): Promise<void> => {
            try {
              // Add timeout to prevent hanging - 5 seconds max
              const reasoningText = await Promise.race([
                result.reasoningText,
                new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
              ]);

              // Detect reasoning-start: if not already processed and reasoningText exists and has meaningful content
              // Guard against processing the same reasoning text multiple times
              if (!hasStartedReasoning && reasoningText && reasoningText.length > 0) {
                await emit(Effect.succeed(Chunk.of({ type: "thinking_start", provider: providerName })));
                hasStartedReasoning = true;
                // Record first token time on first content
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                }

                // Emit reasoning text as chunks
                // Split into reasonable chunks for streaming effect
                const chunkSize = 1000; // characters per chunk
                for (let i = 0; i < reasoningText.length; i += chunkSize) {
                  const chunk = reasoningText.slice(i, i + chunkSize);
                  await emit(Effect.succeed(Chunk.of({
                    type: "thinking_chunk",
                    content: chunk,
                    sequence: reasoningSequence++,
                  })));
                }

                // Emit thinking_complete after all reasoning text is processed
                await emit(Effect.succeed(Chunk.of({
                  type: "thinking_complete",
                })));

                thinkingCompleteEmitted = true;
                hasStartedReasoning = false;
              }
            } catch {
              // Handle reasoningText errors silently
              // Errors are logged via the outer catch handler
            }
          })();

          // Process toolResults Promise with timeout to avoid blocking
          const toolResultsPromise = (async (): Promise<void> => {
            try {
              // Add timeout to prevent hanging - 5 seconds max
              const toolResults = await Promise.race([
                result.toolResults,
                new Promise<Array<unknown>>((resolve) => setTimeout(() => resolve([]), 5000)),
              ]);
              if (toolResults && Array.isArray(toolResults) && toolResults.length > 0) {
                // Process tool results if needed
                // Note: toolResults are typically already handled via tool-call events in fullStream
              }
            } catch {
              // Handle toolResults errors silently
              // Errors are logged via the outer catch handler
            }
          })();

          // Process fullStream for tool calls and other events (but not text/reasoning)
          // Wrap in a promise so we can add timeout and track completion
          const fullStreamPromise = (async (): Promise<void> => {
            streamLoop: for await (const part of result.fullStream) {
                // Stop processing if we've already received finish event and completed
                if (shouldStopFullStream) {
                  break streamLoop;
                }

                switch (part.type) {
                  // Skip text events - handled by textStream
                  case "text-start":
                  case "text-delta":
                  case "text-end": {
                    break;
                  }

                  // Skip reasoning events - handled by reasoningText
                  case "reasoning-start":
                  case "reasoning-delta": {
                    break;
                  }

                  case "reasoning-end": {
                    // Still process reasoning-end to extract reasoning tokens from usage
                    if (hasStartedReasoning || thinkingCompleteEmitted) {
                      const totalUsage = "totalUsage" in part ? part.totalUsage : undefined;
                      const usage = "usage" in part ? part.usage : undefined;
                      // Check both totalUsage and usage for reasoning tokens
                      const totalTokens =
                        totalUsage && typeof totalUsage === "object" && "reasoningTokens" in totalUsage
                          ? (totalUsage as { reasoningTokens?: number }).reasoningTokens
                          : usage && typeof usage === "object" && "reasoningTokens" in usage
                            ? (usage as { reasoningTokens?: number }).reasoningTokens
                            : undefined;
                      // Store reasoning tokens if found for potential later use
                      if (totalTokens !== undefined) {
                        reasoningTokensFromUsage = totalTokens;
                        // Update thinking_complete with token count if not already emitted
                        if (!thinkingCompleteEmitted) {
                          void emit(Effect.succeed(Chunk.of({
                            type: "thinking_complete",
                            totalTokens,
                          })));
                          thinkingCompleteEmitted = true;
                        }
                      }
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
                    collectedToolCalls.push(toolCall);

                    void emit(Effect.succeed(Chunk.of({
                      type: "tool_call",
                      toolCall,
                      sequence: textSequence++,
                    })));
                    break;
                  }

                  case "finish": {
                    // Finish event from fullStream - this is the definitive completion signal
                    // The model is done generating, so we can proceed immediately
                    finishEventReceived = true;
                    shouldStopFullStream = true; // Signal to stop processing fullStream
                    // Resolve completion immediately - finish event means model is done
                    // This is especially important for tool-call-only responses where textStream may not complete
                    completionDeferred.resolve();
                    // Break out of the for loop, not just the switch
                    break streamLoop;
                  }

                  case "error": {
                    // Error during streaming
                    throw part.error;
                  }

                  case "abort": {
                    // Stream was aborted - if we've already completed, just break out
                    // Otherwise emit error (this shouldn't happen after our fix, but keep for safety)
                    if (shouldStopFullStream || finishEventReceived) {
                      // Already completed, just break out of loop
                      break streamLoop;
                    }
                    // Stream was aborted before completion - emit error
                    void emit(Effect.fail(Option.some(
                      new LLMRequestError(providerName, "Stream was aborted"),
                    )));
                    break streamLoop;
                  }

                  default: {
                    // Silently ignore unhandled part types that we don't need
                    // This prevents TypeScript errors and allows the stream to continue
                    break;
                  }
                }
            }
          })();

          // Start all streams in background - they process text, tool calls, and reasoning
          void textStreamPromise.catch(() => {
            // Silently handle errors - completion deferred is already resolved
          });
          void fullStreamPromise.catch(() => {
            // Silently handle errors
          });
          void reasoningTextPromise.catch(() => {
            // Silently handle errors
          });
          void toolResultsPromise.catch(() => {
            // Silently handle errors
          });

          // Wait for completion signal - either textStream completes OR finish event (for tool-call-only responses)
          // This handles both cases:
          // 1. Normal text responses: textStream completes naturally
          // 2. Tool-call-only responses: finish event triggers completion
          const completionWaitStart = Date.now();
          const completionTimeout = 10 * 1000; // 10 seconds safety timeout
          let completionReceived = false;
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

          try {
            // Set up timeout first
            const timeoutPromise = new Promise<void>((resolve) => {
              timeoutHandle = setTimeout(() => {
                // Only log timeout if completion wasn't received
                if (!completionReceived) {
                  console.error(`[DEBUG] Completion timeout after ${completionTimeout}ms (provider: ${providerName})`);
                }
                resolve();
              }, completionTimeout);
            });

            // Race completion against timeout
            await Promise.race([
              completionDeferred.promise.then(() => {
                completionReceived = true;
                // Clear timeout if completion received early
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                }
              }),
              timeoutPromise,
            ]);

            const completionWaitDuration = Date.now() - completionWaitStart;
            if (completionWaitDuration > 100 && !completionReceived) {
              console.error(`[DEBUG] Waited ${completionWaitDuration}ms for completion signal (provider: ${providerName})`, {
                finishEventReceived,
                hasToolCalls: collectedToolCalls.length > 0,
                hasText: accumulatedText.length > 0,
              });
            }
          } catch (error) {
            // If completion errors, log but continue - we may still have accumulated text/tool calls
            console.error(`[DEBUG] Completion error (provider: ${providerName}):`, error);
          } finally {
            // Clean up timeout if it's still pending
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }

          const finalText = accumulatedText;
          const toolCalls = collectedToolCalls.length > 0 ? collectedToolCalls : undefined;

          // Get usage in parallel with building response - don't block on it
          // Start usage retrieval immediately but don't wait for it
          const usagePromise = (async (): Promise<Awaited<typeof result.usage> | undefined> => {
            try {
              return await Promise.race([
                result.usage,
                new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
              ]);
            } catch {
              return undefined;
            }
          })();

          // Build initial response immediately without usage (we'll update it if usage arrives quickly)
          const endTime = Date.now();
          let metrics:
            | { firstTokenLatencyMs: number; tokensPerSecond?: number; totalTokens?: number }
            | undefined;
          if (firstTokenTime) {
            metrics = {
              firstTokenLatencyMs: firstTokenTime - startTime,
            };
          }

          // Build response immediately - usage will be added if available
          const initialResponse: ChatCompletionResponse = {
            id: "",
            model: options.model,
            content: finalText,
            ...(toolCalls ? { toolCalls } : {}),
          };

          // Try to get usage quickly (50ms) - if not available, proceed without it
          const usageStartTime = Date.now();
          let finalUsage: Awaited<typeof result.usage> | undefined = undefined;
          try {
            finalUsage = await Promise.race([
              usagePromise,
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
            ]);
          } catch {
            finalUsage = undefined;
          }
          const usageDuration = Date.now() - usageStartTime;

          // Add usage to response if we got it quickly
          const finalResponse: ChatCompletionResponse = finalUsage
            ? {
                ...initialResponse,
                usage: {
                  promptTokens: finalUsage.inputTokens ?? 0,
                  completionTokens: finalUsage.outputTokens ?? 0,
                  totalTokens: finalUsage.totalTokens ?? 0,
                },
              }
            : initialResponse;

          // Update metrics with usage if available
          if (finalUsage && metrics) {
            const totalDuration = Date.now() - startTime;
            const totalTokens = finalUsage.totalTokens ?? 0;
            metrics = {
              ...metrics,
              ...(totalTokens > 0
                ? {
                    tokensPerSecond: (totalTokens / totalDuration) * 1000,
                    totalTokens,
                  }
                : {}),
            };
          }

          // Extract reasoning tokens from final usage if available
          if (finalUsage && typeof finalUsage === "object") {
            if ("reasoningTokens" in finalUsage && typeof finalUsage["reasoningTokens"] === "number") {
              reasoningTokensFromUsage = finalUsage["reasoningTokens"];
            } else if ("reasoning_tokens" in finalUsage && typeof finalUsage["reasoning_tokens"] === "number") {
              reasoningTokensFromUsage = finalUsage["reasoning_tokens"];
            } else if (
              "experimental_providerMetadata" in finalUsage &&
              typeof finalUsage.experimental_providerMetadata === "object" &&
              finalUsage.experimental_providerMetadata !== null
            ) {
              const metadata = finalUsage.experimental_providerMetadata as Record<string, unknown>;
              if ("reasoningTokens" in metadata && typeof metadata["reasoningTokens"] === "number") {
                reasoningTokensFromUsage = metadata["reasoningTokens"];
              } else if ("reasoning_tokens" in metadata && typeof metadata["reasoning_tokens"] === "number") {
                reasoningTokensFromUsage = metadata["reasoning_tokens"];
              }
            }
          }

          // Emit thinking_complete with tokens if we have them
          if (reasoningTokensFromUsage !== undefined && !thinkingCompleteEmitted) {
            void emit(Effect.succeed(Chunk.of({
              type: "thinking_complete",
              totalTokens: reasoningTokensFromUsage,
            })));
          }

          // Emit usage update if we have it
          if (finalResponse.usage) {
            void emit(Effect.succeed(Chunk.of({ type: "usage_update", usage: finalResponse.usage })));
          }

          // Emit complete event immediately - this is the critical path
          const completeEventTime = Date.now();
          void emit(Effect.succeed(Chunk.of({
            type: "complete",
            response: finalResponse,
            totalDurationMs: endTime - startTime,
            ...(metrics ? { metrics } : {}),
          })));

          // Signal to stop processing fullStream after complete event is emitted
          // This ensures the stream can complete quickly after the complete event
          shouldStopFullStream = true;

          // Resolve the deferred immediately
          responseDeferred.resolve(finalResponse);

          // Abort the streamText result to stop all background processing
          // This allows the stream to close quickly after the complete event
          abortController.abort();

          const completeEventEmitDuration = Date.now() - completeEventTime;
          if (usageDuration > 50 || completeEventEmitDuration > 10) {
            console.error(`[DEBUG] Timing breakdown (provider: ${providerName}):`, {
              usageDuration,
              completeEventEmitDuration,
              totalDuration: endTime - startTime,
            });
          }
        } catch (error) {
          // Convert to LLM error
          const llmError = convertToLLMError(error, providerName);

          // Emit error event
          void emit(Effect.fail(Option.some(llmError)));

          // Reject the deferred
          responseDeferred.reject(llmError);
        }
      })();
    });

    // Return streaming result with cancellation support
    return Effect.succeed({
      stream,
      response: Effect.promise(() => responseDeferred.promise),
      cancel: Effect.sync(() => {
        abortController.abort();
      }),
    }).pipe(
      Effect.catchAll((error) => {
        // Convert any synchronous errors to LLMError
        return Effect.fail(convertToLLMError(error, providerName));
      }),
    );
  }
}

export function createAISDKServiceLayer(): Layer.Layer<
  LLMService,
  LLMConfigurationError,
  ConfigService
> {
  return Layer.effect(
    LLMServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigService;
      const appConfig = yield* configService.appConfig;

      const apiKeys: Record<string, string> = {};

      const openAIAPIKey = appConfig.llm?.openai?.api_key;
      if (openAIAPIKey) apiKeys["openai"] = openAIAPIKey;

      const anthropicAPIKey = appConfig.llm?.anthropic?.api_key;
      if (anthropicAPIKey) apiKeys["anthropic"] = anthropicAPIKey;

      const geminiAPIKey = appConfig.llm?.google?.api_key;
      // Default API key env variable for Google is GOOGLE_GENERATIVE_AI_API_KEY
      if (geminiAPIKey) apiKeys["google_generative_ai"] = geminiAPIKey;

      const mistralAPIKey = appConfig.llm?.mistral?.api_key;
      if (mistralAPIKey) apiKeys["mistral"] = mistralAPIKey;

      const xaiAPIKey = appConfig.llm?.xai?.api_key;
      if (xaiAPIKey) apiKeys["xai"] = xaiAPIKey;

      const providers = Object.keys(apiKeys);
      if (providers.length === 0) {
        return yield* Effect.fail(
          new LLMConfigurationError(
            "unknown",
            "No LLM API keys configured. Set config.llm.<provider>.api_key or env (e.g., OPENAI_API_KEY).",
          ),
        );
      }

      const cfg: AISDKConfig = { apiKeys };
      return new DefaultAISDKService(cfg);
    }),
  );
}
