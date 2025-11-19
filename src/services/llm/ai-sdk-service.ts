import { anthropic, type AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { mistral } from "@ai-sdk/mistral";
import { createOpenAI, openai, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { xai, type XaiProviderOptions } from "@ai-sdk/xai";
import { createOllama, type OllamaCompletionProviderOptions } from "ollama-ai-provider-v2";

import {
  APICallError,
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
import shortUUID from "short-uuid";
import { z } from "zod";
import { MAX_AGENT_STEPS } from "../../constants/agent";
import {
  LLMAuthenticationError,
  LLMConfigurationError,
  LLMRateLimitError,
  LLMRequestError,
  type LLMError,
} from "../../core/types/errors";
import type { LLMConfig } from "../../core/types/index";
import { safeParseJson } from "../../core/utils/json";
import { AgentConfigService, type ConfigService } from "../config";
import { LoggerServiceTag, type LoggerService } from "../logger";
import { type ChatCompletionOptions, type ChatCompletionResponse } from "./chat";
import { LLMServiceTag, type LLMProvider, type LLMService } from "./interfaces";
import { createModelFetcher, type ModelFetcherService } from "./model-fetcher";
import {
  DEFAULT_OLLAMA_BASE_URL,
  PROVIDER_MODELS,
  type ModelInfo,
  type ProviderName,
} from "./models";
import { StreamProcessor } from "./stream-processor";
import type { StreamEvent, StreamingResult } from "./streaming-types";

interface AISDKConfig {
  llmConfig?: LLMConfig;
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

    if (role === "user") {
      return {
        role: "user",
        content: m.content,
      } as UserModelMessage;
    }

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

/**
 * Extract all configured providers from LLMConfig with their API keys
 */
function getConfiguredProviders(llmConfig?: LLMConfig): Array<{ name: string; apiKey: string }> {
  if (!llmConfig) return [];
  const providers: Array<{ name: string; apiKey: string }> = [];

  if (llmConfig.openai?.api_key) {
    providers.push({ name: "openai", apiKey: llmConfig.openai.api_key });
  }
  if (llmConfig.anthropic?.api_key) {
    providers.push({ name: "anthropic", apiKey: llmConfig.anthropic.api_key });
  }
  if (llmConfig.google?.api_key) {
    providers.push({ name: "google", apiKey: llmConfig.google.api_key });
  }
  if (llmConfig.mistral?.api_key) {
    providers.push({ name: "mistral", apiKey: llmConfig.mistral.api_key });
  }
  if (llmConfig.xai?.api_key) {
    providers.push({ name: "xai", apiKey: llmConfig.xai.api_key });
  }
  if (llmConfig.deepseek?.api_key) {
    providers.push({ name: "deepseek", apiKey: llmConfig.deepseek.api_key });
  }

  providers.push({ name: "ollama", apiKey: llmConfig.ollama?.api_key ?? "" });

  return providers;
}

function selectModel(
  providerName: string,
  modelId: ModelName,
  llmConfig?: LLMConfig,
): LanguageModel {
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
    case "ollama": {
      const headers = llmConfig?.ollama?.api_key
        ? { Authorization: `Bearer ${llmConfig.ollama.api_key}` }
        : {};
      const ollamaInstance = createOllama({ baseURL: DEFAULT_OLLAMA_BASE_URL, headers });
      return ollamaInstance(modelId);
    }
    case "openrouter": {
      // Create OpenRouter provider using OpenAI SDK with custom baseURL
      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        headers: {
          "HTTP-Referer": "https://github.com/lvndry/jazz",
          "X-Title": "Jazz CLI",
        },
      });
      return openrouter(modelId);
    }
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
            store: false,
            include: ["reasoning.encrypted_content"],
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
    case "google": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        return {
          google: {
            thinkingConfig: {
              includeThoughts: true,
            },
          } satisfies GoogleGenerativeAIProviderOptions,
        };
      }
      break;
    }
    case "xai": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        return {
          xai: {
            reasoningEffort: reasoningEffort === "medium" ? "low" : reasoningEffort,
          } satisfies XaiProviderOptions,
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
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new LLMAuthenticationError({
        provider: providerName,
        message: error.responseBody || error.message,
      });
    }
  }

  const errorMessage =
    error instanceof Error
      ? typeof error.message === "object"
        ? JSON.stringify(error.message)
        : error.message
      : String(error);
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
    llmError = new LLMRequestError({
      provider: providerName,
      message: `Server error (${httpStatus}): ${errorMessage}`,
    });
  } else {
    if (
      errorMessage.toLowerCase().includes("authentication") ||
      errorMessage.toLowerCase().includes("api key")
    ) {
      llmError = new LLMAuthenticationError({ provider: providerName, message: errorMessage });
    } else {
      llmError = new LLMRequestError({
        provider: providerName,
        message: errorMessage || "Unknown LLM request error",
      });
    }
  }

  return llmError;
}

class AISDKService implements LLMService {
  private config: AISDKConfig;
  private readonly providerModels = PROVIDER_MODELS;
  private readonly modelFetcher: ModelFetcherService;

  constructor(
    config: AISDKConfig,
    private readonly logger: LoggerService,
  ) {
    this.config = config;
    this.modelFetcher = createModelFetcher();

    // Export API keys to env for providers that read from env
    if (this.config.llmConfig) {
      const providers = getConfiguredProviders(this.config.llmConfig);

      providers.forEach(({ name, apiKey }) => {
        if (this.isProviderName(name)) {
          if (name === "google") {
            // ai-sdk default API key env variable for Google is GOOGLE_GENERATIVE_AI_API_KEY
            process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = apiKey;
          } else {
            process.env[`${name.toUpperCase()}_API_KEY`] = apiKey;
          }
        }
      });
    }
  }

  private isProviderName(name: string): name is keyof typeof this.providerModels {
    return Object.hasOwn(this.providerModels, name);
  }

  private getProviderModels(
    providerName: ProviderName,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never> {
    const modelSource = this.providerModels[providerName];

    if (!modelSource) {
      return Effect.fail(
        new LLMConfigurationError({
          provider: providerName,
          message: `Unknown provider: ${providerName}`,
        }),
      );
    }

    if (modelSource.type === "static") {
      return Effect.succeed(modelSource.models);
    }

    const providerConfig = this.config.llmConfig?.[providerName as keyof LLMConfig];
    const baseUrl = modelSource.defaultBaseUrl;

    if (!baseUrl) {
      console.warn(
        `[LLM Warning] Provider '${providerName}' requires dynamic model fetching but no defaultBaseUrl is defined. Skipping provider.`,
      );
      return Effect.succeed([]);
    }

    const apiKey = providerConfig?.api_key;

    return this.modelFetcher.fetchModels(providerName, baseUrl, modelSource.endpointPath, apiKey);
  }

  readonly getProvider: LLMService["getProvider"] = (providerName: ProviderName) => {
    return Effect.gen(this, function* () {
      const models = yield* this.getProviderModels(providerName);

      const provider: LLMProvider = {
        name: providerName,
        supportedModels: models.map((model) => ({ ...model })),
        defaultModel: models[0]?.id ?? "",
        authenticate: () =>
          Effect.try({
            try: () => {
              const providerConfig = this.config.llmConfig?.[providerName as keyof LLMConfig];
              const apiKey = providerConfig?.api_key;

              if (!apiKey) {
                // API Key is optional for Ollama
                if (providerName.toLowerCase() === "ollama") {
                  return Effect.succeed(void 0);
                }
                throw new LLMAuthenticationError({
                  provider: providerName,
                  message: "API key not configured",
                });
              }
              return Effect.succeed(apiKey);
            },
            catch: (error: unknown) =>
              new LLMAuthenticationError({
                provider: providerName,
                message: error instanceof Error ? error.message : String(error),
              }),
          }),
      };

      return provider;
    });
  };

  listProviders(): Effect.Effect<readonly { name: string; configured: boolean }[], never> {
    const configuredProviders = getConfiguredProviders(this.config.llmConfig);
    const configuredNames = new Set(configuredProviders.map((p) => p.name));

    const allProviders = Object.keys(this.providerModels)
      .filter((provider): provider is keyof typeof this.providerModels =>
        this.isProviderName(provider),
      )
      .map((name) => ({
        name,
        configured: configuredNames.has(name),
      }));

    return Effect.succeed(allProviders);
  }

  createChatCompletion(
    providerName: string,
    options: ChatCompletionOptions,
  ): Effect.Effect<ChatCompletionResponse, LLMError> {
    return Effect.tryPromise({
      try: async () => {
        const model = selectModel(providerName, options.model, this.config.llmConfig);

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

        const responseModel = options.model;
        const content = result.text ?? "";
        let toolCalls: ChatCompletionResponse["toolCalls"] | undefined = undefined;
        let usage: ChatCompletionResponse["usage"] | undefined = undefined;

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
          toolCalls = result.toolCalls.map((tc: TypedToolCall<ToolSet>) => ({
            id: tc.toolCallId,
            type: "function" as const,
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          }));
        }

        const resultObj: ChatCompletionResponse = {
          id: shortUUID.generate(),
          model: responseModel,
          content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
        };
        return resultObj;
      },
      catch: (error: unknown) => {
        const llmError = convertToLLMError(error, providerName);

        // Log error details
        const errorDetails: Record<string, unknown> = {
          provider: providerName,
          errorType: llmError._tag,
          message: llmError.message,
        };

        if (error instanceof Error) {
          const e = error as Error & {
            code?: string;
            status?: number;
            statusCode?: number;
            type?: string;
          };
          if (e.code) errorDetails["code"] = e.code;
          if (e.status) errorDetails["status"] = e.status;
          if (e.statusCode) errorDetails["statusCode"] = e.statusCode;
          if (e.type) errorDetails["type"] = e.type;
        }

        console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);
        void this.logger.error(`LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return llmError;
      },
    });
  }

  createStreamingChatCompletion(
    providerName: string,
    options: ChatCompletionOptions,
  ): Effect.Effect<StreamingResult, LLMError> {
    const model = selectModel(providerName, options.model, this.config.llmConfig);

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
    // Prevent unhandled promise rejection if the caller never awaits the response effect
    void responseDeferred.promise.catch((err) => {
      throw err;
    });

    const stream = Stream.async<StreamEvent, LLMError>(
      (
        emit: (effect: Effect.Effect<Chunk.Chunk<StreamEvent>, Option.Option<LLMError>>) => void,
      ) => {
        void (async (): Promise<void> => {
          try {
            const result = streamText({
              model,
              messages: toCoreMessages(options.messages),
              ...(typeof options.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(tools ? { tools } : {}),
              ...(providerOptions ? { providerOptions } : {}),
              abortSignal: abortController.signal,
              stopWhen: stepCountIs(MAX_AGENT_STEPS),
            });

            const processor = new StreamProcessor(
              {
                providerName,
                modelName: options.model,
                hasReasoningEnabled: !!(
                  options.reasoning_effort && options.reasoning_effort !== "disable"
                ),
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
            const llmError = convertToLLMError(error, providerName);

            const errorDetails: Record<string, unknown> = {
              provider: providerName,
              errorType: llmError._tag,
              message: llmError.message,
            };

            if (error instanceof Error) {
              const e = error as Error & {
                code?: string;
                status?: number;
                statusCode?: number;
                type?: string;
              };
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

            console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);

            void this.logger.error(
              `LLM Error: ${llmError._tag} - ${llmError.message}`,
              errorDetails,
            );

            void emit(Effect.fail(Option.some(llmError)));

            responseDeferred.reject(llmError);
          }
        })();
      },
    );

    return Effect.succeed({
      stream,
      response: Effect.promise(() => responseDeferred.promise),
      cancel: Effect.sync(() => {
        abortController.abort();
      }),
    }).pipe(
      Effect.catchAll((error) => {
        const llmError = convertToLLMError(error, providerName);

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

        console.error(`[LLM Error] ${llmError._tag}: ${llmError.message}`, errorDetails);

        void this.logger.error(`LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return Effect.fail(llmError);
      }),
    );
  }
}

export function createAISDKServiceLayer(): Layer.Layer<
  LLMService,
  LLMConfigurationError,
  ConfigService | LoggerService
> {
  return Layer.effect(
    LLMServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigService;
      const logger = yield* LoggerServiceTag;
      const appConfig = yield* configService.appConfig;

      const configuredProviders = getConfiguredProviders(appConfig.llm);

      if (configuredProviders.length === 0) {
        return yield* Effect.fail(
          new LLMConfigurationError({
            provider: "unknown",
            message:
              "No LLM API keys configured. Set config.llm.<provider>.api_key or env (e.g., OPENAI_API_KEY).",
          }),
        );
      }

      const cfg: AISDKConfig = {
        ...(appConfig.llm ? { llmConfig: appConfig.llm } : {}),
      };
      return new AISDKService(cfg, logger);
    }),
  );
}
