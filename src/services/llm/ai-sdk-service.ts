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
import type { StreamingResult } from "./streaming-types.js";
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
        { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true },
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

    // Import StreamEvent type
    type StreamEvent = import("./streaming-types.js").StreamEvent;

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

          // Use AI SDK streamText with AbortSignal
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

          // Process fullStream for all events (text, reasoning, tool calls)
          for await (const part of result.fullStream) {
                // Record first token time (for metrics calculation at the end)
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                }

                switch (part.type) {
                  case "text-delta": {
                    // Emit text start on first text chunk
                    if (!hasStartedText) {
                      void emit(Effect.succeed(Chunk.of({ type: "text_start" })));
                      hasStartedText = true;
                    }

                    // AI SDK uses 'text' property, not 'textDelta'
                    const textDelta = "text" in part ? part.text : "";
                    accumulatedText += textDelta;
                    void emit(Effect.succeed(Chunk.of({
                      type: "text_chunk",
                      delta: textDelta,
                      accumulated: accumulatedText,
                      sequence: textSequence++,
                    })));
                    break;
                  }

                  case "reasoning-delta": {
                    // Reasoning/thinking from models like o1, Claude extended thinking
                    if (!hasStartedReasoning) {
                      void emit(Effect.succeed(Chunk.of({ type: "thinking_start", provider: providerName })));
                      hasStartedReasoning = true;
                    }

                    // AI SDK reasoning events use 'text' property
                    const reasoningText = "text" in part ? part.text : "";
                    void emit(Effect.succeed(Chunk.of({
                      type: "thinking_chunk",
                      content: reasoningText,
                      sequence: reasoningSequence++,
                    })));
                    break;
                  }


                  case "tool-call": {
                    // Tool call detected
                    const toolCall: ToolCall = {
                      id: part.toolCallId,
                      type: "function",
                      function: {
                        name: part.toolName,
                        arguments: JSON.stringify(part.input),
                      },
                    };

                    void emit(Effect.succeed(Chunk.of({
                      type: "tool_call",
                      toolCall,
                      sequence: textSequence++,
                    })));
                    break;
                  }

                  case "finish": {
                    // Final completion event from AI SDK
                    if (hasStartedReasoning) {
                      const totalTokens =
                        "totalUsage" in part && part.totalUsage?.reasoningTokens
                          ? part.totalUsage.reasoningTokens
                          : undefined;
                      void emit(Effect.succeed(Chunk.of({
                        type: "thinking_complete",
                        ...(totalTokens !== undefined ? { totalTokens } : {}),
                      })));
                    }
                    break;
                  }

                  case "error": {
                    // Error during streaming
                    throw part.error;
                  }
                }
              }

              // Stream is complete, get final values
              // AI SDK provides these as promises
              const finalText = await result.text;
              const finalToolCalls = await result.toolCalls;
              const finalUsage = await result.usage;

              // Build usage object
              const usage = finalUsage
                ? {
                    promptTokens: finalUsage.inputTokens ?? 0,
                    completionTokens: finalUsage.outputTokens ?? 0,
                    totalTokens: finalUsage.totalTokens ?? 0,
                  }
                : undefined;

              if (usage) {
                void emit(Effect.succeed(Chunk.of({ type: "usage_update", usage })));
              }

              // Calculate metrics for complete event (if enabled via logging.showMetrics)
              // Metrics are only included in the complete event, not emitted separately
              let metrics:
                | { firstTokenLatencyMs: number; tokensPerSecond?: number; totalTokens?: number }
                | undefined;
              if (firstTokenTime && usage?.totalTokens) {
                const totalDuration = Date.now() - startTime;
                const tokensPerSecond = (usage.totalTokens / totalDuration) * 1000;
                metrics = {
                  firstTokenLatencyMs: firstTokenTime - startTime,
                  tokensPerSecond,
                  totalTokens: usage.totalTokens,
                };
              }

              // Convert AI SDK tool calls to our format
              const toolCalls =
                finalToolCalls && finalToolCalls.length > 0
                  ? finalToolCalls.map((tc: TypedToolCall<ToolSet>) => ({
                      id: tc.toolCallId,
                      type: "function" as const,
                      function: {
                        name: tc.toolName,
                        arguments: JSON.stringify(tc.input ?? {}),
                      },
                    }))
                  : undefined;

              // Build final response
              const finalResponse: ChatCompletionResponse = {
                id: "",
                model: options.model,
                content: finalText,
                ...(toolCalls ? { toolCalls } : {}),
                ...(usage ? { usage } : {}),
              };

              // Emit complete event with metrics (if calculated)
              const endTime = Date.now();
              void emit(Effect.succeed(Chunk.of({
                type: "complete",
                response: finalResponse,
                totalDurationMs: endTime - startTime,
                ...(metrics ? { metrics } : {}),
              })));

              // Resolve the deferred with final response
              responseDeferred.resolve(finalResponse);
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
