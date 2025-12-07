import { anthropic, type AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { mistral } from "@ai-sdk/mistral";
import { openai, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { xai, type XaiProviderOptions } from "@ai-sdk/xai";
import { createOpenRouter, type OpenRouterProviderSettings } from "@openrouter/ai-sdk-provider";
import {
  gateway,
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
import { createOllama, type OllamaCompletionProviderOptions } from "ollama-ai-provider-v2";
import shortUUID from "short-uuid";
import { z } from "zod";
import { MAX_AGENT_STEPS } from "../../core/constants/agent";
import type { ProviderName } from "../../core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../../core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../core/interfaces/logger";
import type {
  ChatCompletionOptions,
  ChatCompletionResponse,
  LLMConfig,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  StreamingResult,
} from "../../core/types";
import {
  LLMAuthenticationError,
  LLMConfigurationError,
  type LLMError,
} from "../../core/types/errors";
import { safeParseJson } from "../../core/utils/json";
import { convertToLLMError, truncateRequestBodyValues } from "../../core/utils/llm-error";
import { createDeferred } from "../../core/utils/promise";
import { createModelFetcher, type ModelFetcherService } from "./model-fetcher";
import { DEFAULT_OLLAMA_BASE_URL, PROVIDER_MODELS } from "./models";
import { StreamProcessor } from "./stream-processor";

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
function getConfiguredProviders(llmConfig?: LLMConfig): { name: ProviderName; apiKey: string }[] {
  if (!llmConfig) return [];
  const providers: { name: ProviderName; apiKey: string }[] = [];

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
  if (llmConfig.openrouter?.api_key) {
    providers.push({ name: "openrouter", apiKey: llmConfig.openrouter.api_key });
  }
  if (llmConfig.ai_gateway?.api_key) {
    providers.push({ name: "ai_gateway", apiKey: llmConfig.ai_gateway.api_key });
  }
  if (llmConfig.groq?.api_key) {
    providers.push({ name: "groq", apiKey: llmConfig.groq.api_key });
  }
  providers.push({ name: "ollama", apiKey: llmConfig.ollama?.api_key ?? "" });

  return providers;
}

function selectModel(
  providerName: ProviderName,
  modelId: ModelName,
  llmConfig?: LLMConfig,
  cache?: Map<string, LanguageModel>,
): LanguageModel {
  // Check cache first
  const cacheKey = `${providerName}:${modelId}`;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  let model: LanguageModel;

  switch (providerName.toLowerCase()) {
    case "openai":
      model = openai(modelId);
      break;
    case "anthropic":
      model = anthropic(modelId);
      break;
    case "google":
      model = google(modelId);
      break;
    case "mistral":
      model = mistral(modelId);
      break;
    case "xai":
      model = xai(modelId);
      break;
    case "deepseek":
      model = (deepseek as (modelId: ModelName) => LanguageModel)(modelId);
      break;
    case "ollama": {
      const headers = llmConfig?.ollama?.api_key
        ? { Authorization: `Bearer ${llmConfig.ollama.api_key}` }
        : {};
      const ollamaInstance = createOllama({ baseURL: DEFAULT_OLLAMA_BASE_URL, headers });
      model = ollamaInstance(modelId);
      break;
    }
    case "openrouter": {
      const apiKey: string | undefined = llmConfig?.openrouter?.api_key;
      const headers: Record<string, string> = {
        "HTTP-Referer": "https://github.com/lvndry/jazz",
        "X-Title": "Jazz CLI",
      };
      const config: OpenRouterProviderSettings = {
        ...(apiKey ? { apiKey } : {}),
        compatibility: "strict",
        headers,
      };

      const openrouter = (
        createOpenRouter as (
          config: OpenRouterProviderSettings,
        ) => (modelId: ModelName) => LanguageModel
      )(config);
      model = openrouter(modelId);
      break;
    }
    case "ai_gateway": {
      model = gateway(modelId);
      break;
    }
    case "groq": {
      model = groq(modelId);
      break;
    }
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }

  // Store in cache
  cache?.set(cacheKey, model);
  return model;
}

function buildProviderOptions(
  providerName: ProviderName,
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
        const geminiProReasoningEffort = options.model.includes("gemini-3")
          ? reasoningEffort
          : undefined;
        return {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              ...(geminiProReasoningEffort ? { thinkingLevel: geminiProReasoningEffort } : {}),
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

class AISDKService implements LLMService {
  private config: AISDKConfig;
  private readonly providerModels = PROVIDER_MODELS;
  private readonly modelFetcher: ModelFetcherService;
  // Model instance cache: key = "provider:modelId"
  private readonly modelCache = new Map<string, LanguageModel>();

  constructor(
    config: AISDKConfig,
    private readonly logger: LoggerService,
  ) {
    this.config = config;
    this.modelFetcher = createModelFetcher();

    if (this.config.llmConfig) {
      const providers = getConfiguredProviders(this.config.llmConfig);

      providers.forEach(({ name, apiKey }) => {
        if (name === "google") {
          // ai-sdk default API key env variable for Google is GOOGLE_GENERATIVE_AI_API_KEY
          process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = apiKey;
        } else {
          process.env[`${name.toUpperCase()}_API_KEY`] = apiKey;
        }
      });
    }
  }

  private isProviderName(name: string): name is ProviderName {
    return Object.hasOwn(this.providerModels, name);
  }

  private getProviderModels(
    providerName: ProviderName,
  ): Effect.Effect<readonly ModelInfo[], LLMConfigurationError, never> {
    const modelSource = this.providerModels[providerName];

    if (modelSource.type === "static") {
      return Effect.succeed(modelSource.models);
    }

    const providerConfig = this.config.llmConfig?.[providerName];
    const baseUrl = modelSource.defaultBaseUrl;

    if (!baseUrl) {
      void this.logger.warn(
        `[LLM Warning] Provider '${providerName}' requires dynamic model fetching but no defaultBaseUrl is defined. Skipping provider.`,
      );
      return Effect.succeed([]);
    }

    const apiKey = providerConfig?.api_key;

    return this.modelFetcher.fetchModels(providerName, baseUrl, modelSource.endpointPath, apiKey);
  }

  readonly getProvider = (
    providerName: ProviderName,
  ): Effect.Effect<LLMProvider, LLMConfigurationError, never> => {
    return this.getProviderModels(providerName).pipe(
      Effect.map((models) => {
        const provider: LLMProvider = {
          name: providerName,
          supportedModels: models.map((model) => model),
          defaultModel: models[0]?.id ?? "",
          authenticate: () => {
            const providerConfig = this.config.llmConfig?.[providerName as keyof LLMConfig];
            const apiKey = providerConfig?.api_key;

            if (!apiKey) {
              // API Key is optional for Ollama
              if (providerName.toLowerCase() === "ollama") {
                return Effect.succeed(void 0);
              }
              return Effect.fail(
                new LLMAuthenticationError({
                  provider: providerName,
                  message: "API key not configured",
                }),
              );
            }
            return Effect.succeed(apiKey);
          },
        };

        return provider;
      }),
    );
  };

  listProviders(): Effect.Effect<readonly { name: ProviderName; configured: boolean }[], never> {
    const configuredProviders = getConfiguredProviders(this.config.llmConfig);
    const configuredNames = new Set(configuredProviders.map((p) => p.name));

    const allProviders = Object.keys(this.providerModels)
      .filter((provider): provider is ProviderName => this.isProviderName(provider))
      .map((name) => ({
        name,
        configured: configuredNames.has(name),
      }));

    return Effect.succeed(allProviders);
  }

  createChatCompletion(
    providerName: ProviderName,
    options: ChatCompletionOptions,
  ): Effect.Effect<ChatCompletionResponse, LLMError> {
    return Effect.tryPromise({
      try: async () => {
        const timingStart = Date.now();
        void this.logger.debug(
          `[LLM Timing] Starting non-streaming completion for ${providerName}:${options.model}`,
        );

        const modelSelectStart = Date.now();
        const model = selectModel(
          providerName,
          options.model,
          this.config.llmConfig,
          this.modelCache,
        );
        void this.logger.debug(
          `[LLM Timing] Model selection took ${Date.now() - modelSelectStart}ms`,
        );

        // Prepare tools for AI SDK if present
        let tools: ToolSet | undefined;
        if (options.tools && options.tools.length > 0) {
          const toolConversionStart = Date.now();
          tools = {};

          for (const toolDef of options.tools) {
            tools[toolDef.function.name] = tool({
              description: toolDef.function.description,
              inputSchema: toolDef.function.parameters as unknown as z.ZodTypeAny,
            });
          }
          void this.logger.debug(
            `[LLM Timing] Tool conversion (${options.tools.length} tools) took ${Date.now() - toolConversionStart}ms`,
          );
        }

        const providerOptions = buildProviderOptions(providerName, options);

        const messageConversionStart = Date.now();
        const coreMessages = toCoreMessages(options.messages);
        void this.logger.debug(
          `[LLM Timing] Message conversion (${options.messages.length} messages) took ${Date.now() - messageConversionStart}ms`,
        );

        const generateTextStart = Date.now();
        void this.logger.debug(`[LLM Timing] Calling generateText...`);
        const result = await generateText({
          model,
          messages: coreMessages,
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
          ...(tools ? { tools } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
        });
        void this.logger.debug(
          `[LLM Timing] generateText completed in ${Date.now() - generateTextStart}ms`,
        );
        void this.logger.info(`[LLM Timing] Total completion time: ${Date.now() - timingStart}ms`);

        const responseModel = options.model;
        const content = result.text ?? "";
        let toolCalls: ChatCompletionResponse["toolCalls"] = undefined;
        let usage: ChatCompletionResponse["usage"] = undefined;

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

        const truncatedRequestBody = truncateRequestBodyValues(error);
        if (truncatedRequestBody) {
          errorDetails["requestBodyValues"] = truncatedRequestBody;
        }

        void this.logger.error(`LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return llmError;
      },
    });
  }

  createStreamingChatCompletion(
    providerName: ProviderName,
    options: ChatCompletionOptions,
  ): Effect.Effect<StreamingResult, LLMError> {
    const timingStart = Date.now();
    void this.logger.debug(
      `[LLM Timing] ⏱️  Starting streaming completion for ${providerName}:${options.model}`,
    );

    const modelSelectStart = Date.now();
    const model = selectModel(providerName, options.model, this.config.llmConfig, this.modelCache);
    void this.logger.debug(`[LLM Timing] Model selection took ${Date.now() - modelSelectStart}ms`);

    let tools: ToolSet | undefined;
    if (options.tools && options.tools.length > 0) {
      const toolConversionStart = Date.now();
      tools = {};
      for (const toolDef of options.tools) {
        tools[toolDef.function.name] = tool({
          description: toolDef.function.description,
          inputSchema: toolDef.function.parameters as unknown as z.ZodTypeAny,
        });
      }
      void this.logger.debug(
        `[LLM Timing] Tool conversion (${options.tools.length} tools) took ${Date.now() - toolConversionStart}ms`,
      );
    }

    const providerOptions = buildProviderOptions(providerName, options);

    // Message conversion timing
    const messageConversionStart = Date.now();
    const coreMessages = toCoreMessages(options.messages);
    void this.logger.debug(
      `[LLM Timing] Message conversion (${options.messages.length} messages) took ${Date.now() - messageConversionStart}ms`,
    );

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
            const streamTextStart = Date.now();
            void this.logger.debug(
              `[LLM Timing] 🚀 Calling streamText at +${streamTextStart - timingStart}ms...`,
            );

            const result = streamText({
              model,
              messages: coreMessages,
              ...(typeof options.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(tools ? { tools } : {}),
              ...(providerOptions ? { providerOptions } : {}),
              abortSignal: abortController.signal,
              stopWhen: stepCountIs(MAX_AGENT_STEPS),
            });

            void this.logger.debug(
              `[LLM Timing] ✓ streamText returned (initialization) in ${Date.now() - streamTextStart}ms`,
            );

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
              this.logger,
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

            // Truncate requestBodyValues to keep only last 5 messages
            const truncatedRequestBody = truncateRequestBodyValues(error, 5);
            if (truncatedRequestBody) {
              errorDetails["requestBodyValues"] = truncatedRequestBody;
            }

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

        // Truncate requestBodyValues to keep only last 5 messages
        const truncatedRequestBody = truncateRequestBodyValues(error, 5);
        if (truncatedRequestBody) {
          errorDetails["requestBodyValues"] = truncatedRequestBody;
        }

        void this.logger.error(`LLM Error: ${llmError._tag} - ${llmError.message}`, errorDetails);

        return Effect.fail(llmError);
      }),
    );
  }
}

export function createAISDKServiceLayer(): Layer.Layer<
  LLMService,
  LLMConfigurationError,
  AgentConfigService | LoggerService
> {
  return Layer.effect(
    LLMServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
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
