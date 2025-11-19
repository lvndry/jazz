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
import {
  LLMAuthenticationError,
  LLMConfigurationError,
  LLMError,
  LLMRateLimitError,
  LLMRequestError,
} from "../../core/types/errors";
import { safeParseJson } from "../../core/utils/json";
import { AgentConfigService, type ConfigService } from "../config";
import { writeLogToFile } from "../logger";
import { LLMProvider, LLMService, LLMServiceTag } from "./interfaces";
import { ChatCompletionOptions, ChatCompletionResponse } from "./models";
import { PROVIDER_MODELS, type ProviderName } from "./providers";
import { StreamProcessor } from "./stream-processor";
import type { StreamEvent, StreamingResult } from "./streaming-types";

interface AISDKConfig {
  apiKeys: Record<string, string>;
}

function parseToolArguments(input: string): Record<string, unknown> {
  const parsed = safeParseJson<Record<string, unknown>>(input);
  return Option.match(parsed, {
    onNone: () => ({}),
    onSome: (value) => (value && typeof value === "object" ? value : {}),
  });
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
            input: parseToolArguments(tc.function.arguments),
          });
        }
      }

      return { role: "assistant", content: contentParts } as AssistantModelMessage;
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
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

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

  let llmError: LLMError;
  if (httpStatus === 401 || httpStatus === 403) {
    llmError = new LLMAuthenticationError({ provider: providerName, message: errorMessage });
  } else if (httpStatus === 429) {
    llmError = new LLMRateLimitError({ provider: providerName, message: errorMessage });
  } else if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    llmError = new LLMRequestError({ provider: providerName, message: errorMessage });
  } else if (httpStatus && httpStatus >= 500) {
    llmError = new LLMRequestError({ provider: providerName, message: `Server error (${httpStatus}): ${errorMessage}` });
  } else {
    if (
      errorMessage.toLowerCase().includes("authentication") ||
      errorMessage.toLowerCase().includes("api key")
    ) {
      llmError = new LLMAuthenticationError({ provider: providerName, message: errorMessage });
    } else {
      llmError = new LLMRequestError({ provider: providerName, message: errorMessage || "Unknown LLM request error" });
    }
  }

  return llmError;
}



class AISDKService implements LLMService {
  private config: AISDKConfig;
  private readonly providerModels = PROVIDER_MODELS;

  constructor(config: AISDKConfig) {
    this.config = config;

    // Export API keys to env for providers that read from env
    Object.entries(this.config.apiKeys).forEach(([provider, apiKey]) => {
      process.env[`${provider.toUpperCase()}_API_KEY`] = apiKey;
    });

  }

  private isProviderName(name: string): name is keyof typeof this.providerModels {
    return Object.hasOwn(this.providerModels, name);
  }

  readonly getProvider: LLMService["getProvider"] = (providerName: ProviderName) => {
    return Effect.try({
      try: () => {
        if (!this.isProviderName(providerName)) {
          throw new LLMConfigurationError({ provider: providerName, message: `Provider not supported: ${providerName}` });
        }

        const models = this.providerModels[providerName];
        const provider: LLMProvider = {
          name: providerName,
          supportedModels: models.map((model) => ({ ...model })),
          defaultModel: models[0]?.id ?? "",
          authenticate: () =>
            Effect.try({
              try: () => {
                const apiKey = this.config.apiKeys[providerName];
                if (!apiKey) {
                  throw new LLMAuthenticationError({ provider: providerName, message: "API key not configured" });
                }
              },
              catch: (error: unknown) =>
                new LLMAuthenticationError({
                  provider: providerName,
                  message: error instanceof Error ? error.message : String(error),
                }),
            }),
          createChatCompletion: (options) => this.createChatCompletion(providerName, options),
        };

        return provider;
      },
      catch: (error: unknown) =>
        new LLMConfigurationError({
          provider: providerName,
          message: `Failed to get provider: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  };

  listProviders(): Effect.Effect<readonly string[], never> {
    const configuredProviders = Object.keys(this.config.apiKeys);
    const intersect = configuredProviders.filter((provider): provider is keyof typeof this.providerModels =>
      this.isProviderName(provider),
    );
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
      catch: (error: unknown) => {
        const llmError = convertToLLMError(error, providerName) as LLMAuthenticationError | LLMRateLimitError | LLMRequestError;

        // Log error details
        const errorDetails: Record<string, unknown> = {
          provider: providerName,
          errorType: llmError._tag,
          message: llmError.message,
        };

        if (error instanceof Error) {
          const e = error as Error & { code?: string; status?: number; statusCode?: number; type?: string };
          if (e.code) errorDetails["code"] = e.code;
          if (e.status) errorDetails["status"] = e.status;
          if (e.statusCode) errorDetails["statusCode"] = e.statusCode;
          if (e.type) errorDetails["type"] = e.type;
        }

        // Log to console for immediate visibility
        console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);

        // Also log to file for persistence
        void writeLogToFile("error", `LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return llmError;
      },
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

    // Create the stream using Stream.async
    const stream = Stream.async<StreamEvent, LLMError>(
      (emit: (effect: Effect.Effect<Chunk.Chunk<StreamEvent>, Option.Option<LLMError>>) => void) => {
        // Start async processing
        void (async (): Promise<void> => {
          try {
            // Create the AI SDK stream
            const result = streamText({
              model,
              messages: toCoreMessages(options.messages),
              ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
              ...(tools ? { tools } : {}),
              ...(providerOptions ? { providerOptions } : {}),
              abortSignal: abortController.signal,
              stopWhen: stepCountIs(MAX_AGENT_STEPS),
            });

            // Create stream processor
            const processor = new StreamProcessor(
              {
                providerName,
                modelName: options.model,
                hasReasoningEnabled: !!(options.reasoning_effort && options.reasoning_effort !== "disable"),
                startTime: Date.now(),
              },
              emit,
            );

            // Process the stream and get final response
            const finalResponse = await processor.process(result);

            // Resolve deferred for consumers who just await response
            responseDeferred.resolve(finalResponse);

            // Close the stream
            processor.close();
          } catch (error) {
            // Convert to LLM error
            const llmError = convertToLLMError(error, providerName) as LLMAuthenticationError | LLMRateLimitError | LLMRequestError;

            // Log the error details
            const errorDetails: Record<string, unknown> = {
              provider: providerName,
              errorType: llmError._tag,
              message: llmError.message,
            };
            if (error instanceof Error) {
              const e = error as Error & { code?: string; status?: number; statusCode?: number; type?: string };
              if (e.code) errorDetails["code"] = e.code;
              if (e.status) errorDetails["status"] = e.status;
              if (e.statusCode) errorDetails["statusCode"] = e.statusCode;
              if (e.type) errorDetails["type"] = e.type;
              if (typeof error === "object" && error !== null) {
                try {
                  const errorObj = error as unknown as Record<string, unknown>;
                  if (errorObj["param"]) errorDetails["param"] = errorObj["param"];
                } catch {
                  // Ignore
                }
              }
            }
            // Log to console for immediate visibility
            console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);

            // Also log to file for persistence
            void writeLogToFile("error", `LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

            // Emit error event
            void emit(Effect.fail(Option.some(llmError)));

            // Reject the deferred
            responseDeferred.reject(llmError);

            // Close the stream
            void emit(Effect.fail(Option.none()));
          }
        })();
      },
    );

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
        const llmError = convertToLLMError(error, providerName) as LLMAuthenticationError | LLMRateLimitError | LLMRequestError;

        // Log error details
        const errorDetails: Record<string, unknown> = {
          provider: providerName,
          errorType: llmError._tag,
          message: llmError.message,
        };
        if (error && typeof error === "object" && "code" in error) {
          const e = error as { code?: string; status?: number; statusCode?: number; type?: string };
          if (e.code) errorDetails["code"] = e.code;
          if (e.status) errorDetails["status"] = e.status;
          if (e.statusCode) errorDetails["statusCode"] = e.statusCode;
          if (e.type) errorDetails["type"] = e.type;
        }

        // Log to console for immediate visibility
        console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);

        // Also log to file for persistence
        void writeLogToFile("error", `LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return Effect.fail(llmError);
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
          new LLMConfigurationError({
            provider: "unknown",
            message: "No LLM API keys configured. Set config.llm.<provider>.api_key or env (e.g., OPENAI_API_KEY).",
          }),
        );
      }

      const cfg: AISDKConfig = { apiKeys };
      return new AISDKService(cfg);
    }),
  );
}
