/* eslint-disable import/order */
import { MAX_AGENT_STEPS } from "@/core/constants/agent";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type {
  ChatCompletionOptions,
  ChatCompletionResponse,
  LLMConfig,
  LLMProvider,
  LLMProviderListItem,
  ModelInfo,
  StreamEvent,
  StreamingResult,
} from "@/core/types";
import type { WebSearchConfig } from "@/core/types/config";
import { LLMAuthenticationError, LLMConfigurationError, type LLMError } from "@/core/types/errors";
import type { ToolCall } from "@/core/types/tools";
import { safeParseJson } from "@/core/utils/json";
import {
  convertToLLMError,
  extractCleanErrorMessage,
  truncateRequestBodyValues,
} from "@/core/utils/llm-error";
import { createDeferred } from "@/core/utils/promise";
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
import { createModelFetcher, type ModelFetcherService } from "./model-fetcher";
import { DEFAULT_OLLAMA_BASE_URL, PROVIDER_MODELS } from "./models";
import { StreamProcessor } from "./stream-processor";

interface AISDKConfig {
  llmConfig?: LLMConfig;
  webSearchConfig?: WebSearchConfig;
}

function parseToolArguments(input: string): Record<string, unknown> {
  const parsed = safeParseJson<Record<string, unknown>>(input);
  return Option.match(parsed, {
    onNone: () => ({}),
    onSome: (value) => (value && typeof value === "object" ? value : {}),
  });
}

function toAISDKToolChoice(
  toolChoice: ChatCompletionOptions["toolChoice"],
): AISDKToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;

  return {
    type: "tool",
    toolName: toolChoice.function.name,
  };
}

function buildToolConfig(
  supportsTools: boolean,
  tools: ChatCompletionOptions["tools"],
  toolChoice: ChatCompletionOptions["toolChoice"],
): {
  tools: ChatCompletionOptions["tools"] | undefined;
  toolChoice: AISDKToolChoice | undefined;
  toolsDisabled: boolean;
} {
  if (!tools || tools.length === 0 || !supportsTools) {
    return {
      tools: undefined,
      toolChoice: undefined,
      toolsDisabled: !!tools && tools.length > 0 && !supportsTools,
    };
  }

  return {
    tools,
    toolChoice: toAISDKToolChoice(toolChoice),
    toolsDisabled: false,
  };
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
      thought_signature?: string;
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
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
            thoughtSignature?: string;
          }
      > = [];

      if (m.content && m.content.length > 0) {
        contentParts.push({ type: "text", text: m.content });
      }

      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const toolCallPart: {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
            providerOptions?: { google?: { thoughtSignature?: string } };
          } = {
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          };

          // Preserve thought_signature for Google/Gemini models
          // The AI SDK expects it in providerOptions.google.thoughtSignature format
          if (tc.thought_signature) {
            toolCallPart.providerOptions = {
              google: {
                thoughtSignature: tc.thought_signature,
              },
            };
          }

          contentParts.push(toolCallPart);
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
type AISDKToolChoice = Parameters<typeof generateText>[0]["toolChoice"];

/**
 * Check if any external web search API keys are configured
 * Returns true if at least one external provider (exa, parallel, tavily) has an API key
 */
function hasExternalWebSearchKeys(webSearchConfig?: WebSearchConfig): boolean {
  if (!webSearchConfig) return false;

  return !!(
    webSearchConfig.exa?.api_key ||
    webSearchConfig.parallel?.api_key ||
    webSearchConfig.tavily?.api_key
  );
}

/**
 * Get provider-native web search tool if supported by the provider
 * Returns the tool instance or null if not supported
 */
function getProviderNativeWebSearchTool(
  providerName: ProviderName,
  logger?: LoggerService,
): ToolSet[string] | null {
  const normalizedProvider = providerName.toLowerCase();

  try {
    switch (normalizedProvider) {
      case "openai": {
        const openaiWithTools = openai as typeof openai & {
          tools?: { webSearch?: (config?: { externalWebAccess?: boolean; searchContextSize?: string }) => ToolSet[string] };
        };
        if (typeof openaiWithTools.tools?.webSearch === "function") {
          return openaiWithTools.tools.webSearch({
            externalWebAccess: true,
            searchContextSize: "high",
          });
        }
        return null;
      }
      case "anthropic": {
        const anthropicWithTools = anthropic as typeof anthropic & {
          tools?: { webSearch_20250305?: (config?: { maxUses?: number }) => ToolSet[string] };
        };
        if (typeof anthropicWithTools.tools?.webSearch_20250305 === "function") {
          return anthropicWithTools.tools.webSearch_20250305({
            maxUses: 5,
          });
        }
        return null;
      }
      case "google": {
        const googleWithTools = google as typeof google & {
          tools?: { googleSearch?: (config?: Record<string, unknown>) => ToolSet[string] };
        };
        if (typeof googleWithTools.tools?.googleSearch === "function") {
          return googleWithTools.tools.googleSearch({});
        }
        return null;
      }
      case "xai": {
        const xaiWithTools = xai as typeof xai & {
          tools?: { webSearch?: (config?: Record<string, unknown>) => ToolSet[string] };
        };
        if (typeof xaiWithTools.tools?.webSearch === "function") {
          return xaiWithTools.tools.webSearch({});
        }
        return null;
      }
      case "groq": {
        const groqWithTools = groq as typeof groq & {
          tools?: { browserSearch?: (config?: Record<string, unknown>) => ToolSet[string] };
        };
        if (typeof groqWithTools.tools?.browserSearch === "function") {
          return groqWithTools.tools.browserSearch({});
        }
        return null;
      }
      default:
        return null;
    }
  } catch (error) {
    if (logger) {
      void logger.warn(
        `[Web Search Error] Failed to get native web search tool for ${providerName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/**
 * Check if a provider supports native web search
 * This is exposed via LLMService for CLI logic
 */
function checkProviderNativeWebSearchSupport(
  providerName: ProviderName,
  logger?: LoggerService,
): boolean {
  return getProviderNativeWebSearchTool(providerName, logger) !== null;
}

/**
 * Extract all configured providers from LLMConfig with their API keys
 */
function getConfiguredProviders(
  llmConfig?: LLMConfig,
): { name: ProviderName; apiKey: string; displayName?: string }[] {
  if (!llmConfig) return [];
  const providers: { name: ProviderName; apiKey: string; displayName?: string }[] = [];

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
    providers.push({
      name: "ai_gateway",
      displayName: "ai gateway",
      apiKey: llmConfig.ai_gateway.api_key,
    });
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
            reasoningSummary: "auto",
            // store: false,
            // include: ["reasoning.encrypted_content"],
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
  private readonly modelInfoCache = new Map<ProviderName, readonly ModelInfo[]>();

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
    const cached = this.modelInfoCache.get(providerName);
    if (cached) {
      return Effect.succeed(cached);
    }

    const modelSource = this.providerModels[providerName];

    if (modelSource.type === "static") {
      this.modelInfoCache.set(providerName, modelSource.models);
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

    return this.modelFetcher
      .fetchModels(providerName, baseUrl, modelSource.endpointPath, apiKey)
      .pipe(
        Effect.tap((models) =>
          Effect.sync(() => {
            this.modelInfoCache.set(providerName, models);
          }),
        ),
      );
  }

  private async resolveModelInfo(
    providerName: ProviderName,
    modelId: ModelName,
  ): Promise<ModelInfo | undefined> {
    const models = await Effect.runPromise(this.getProviderModels(providerName));
    return models.find((model) => model.id === modelId);
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

  listProviders(): Effect.Effect<readonly LLMProviderListItem[], never> {
    const configuredProviders = getConfiguredProviders(this.config.llmConfig);
    const configuredNames = new Set(configuredProviders.map((p) => p.name));

    const allProviders = Object.keys(this.providerModels)
      .filter((provider): provider is ProviderName => this.isProviderName(provider))
      .map((name) => ({
        name,
        ...(name === "ai_gateway" ? { displayName: "ai gateway" } : {}),
        configured: configuredNames.has(name),
      }));

    return Effect.succeed(allProviders);
  }

  private prepareTools(
    providerName: ProviderName,
    requestedTools: ChatCompletionOptions["tools"],
  ): ToolSet | undefined {
    if (!requestedTools || requestedTools.length === 0) {
      return undefined;
    }

    const toolConversionStart = Date.now();
    const tools: ToolSet = {};

    // First, map all requested tools to the AI SDK format.
    for (const toolDef of requestedTools) {
      tools[toolDef.function.name] = tool({
        description: toolDef.function.description,
        inputSchema: toolDef.function.parameters as unknown as z.ZodTypeAny,
      });
    }

    // Now, handle the special case for web_search.
    const hasWebSearch = requestedTools.some((t) => t.function.name === "web_search");
    if (hasWebSearch) {
      const providerNativeWebSearch = getProviderNativeWebSearchTool(providerName, this.logger);
      const hasExternalKeys = hasExternalWebSearchKeys(this.config.webSearchConfig);
      const shouldUseProviderNative = providerNativeWebSearch && !hasExternalKeys;

      if (shouldUseProviderNative) {
        void this.logger.debug(
          `[Web Search] Using provider-native web search tool for ${providerName} (no external API keys configured)`,
        );
        tools["web_search"] = providerNativeWebSearch;
      } else {
        if (providerNativeWebSearch && hasExternalKeys) {
          void this.logger.debug(
            `[Web Search] Using Jazz web_search tool (external API keys configured, overriding provider-native tool)`,
          );
        } else if (!providerNativeWebSearch) {
          void this.logger.debug(
            `[Web Search] Using Jazz web_search tool (provider ${providerName} does not support native web search)`,
          );
        }
      }
    }

    void this.logger.debug(
      `[LLM Timing] Tool conversion (${Object.keys(tools).length} tools) took ${Date.now() - toolConversionStart}ms`,
    );

    return tools;
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

        const modelInfo = await this.resolveModelInfo(providerName, options.model);
        // STEP 6: Tools selection
        // Check if the selected model supports tools
        const supportsTools: boolean = modelInfo?.supportsTools ?? false;
        const {
          tools: requestedTools,
          toolChoice: requestedToolChoice,
          toolsDisabled,
        } = buildToolConfig(supportsTools, options.tools, options.toolChoice);

        // Prepare tools for AI SDK if present
        // Prepare tools for AI SDK if present
        const tools = this.prepareTools(providerName, requestedTools);

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
          ...(requestedToolChoice ? { toolChoice: requestedToolChoice } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
        });
        void this.logger.debug(
          `[LLM Timing] generateText completed in ${Date.now() - generateTextStart}ms`,
        );
        void this.logger.info(`[LLM Timing] Total completion time: ${Date.now() - timingStart}ms`);

        if (toolsDisabled) {
          void this.logger.info(
            `Tools were provided but skipped because ${options.model} does not support tools`,
          );
        }

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
          toolCalls = result.toolCalls.map((tc: TypedToolCall<ToolSet>) => {
            const toolCall: ToolCall = {
              id: tc.toolCallId,
              type: "function" as const,
              function: {
                name: tc.toolName,
                arguments: JSON.stringify(tc.input ?? {}),
              },
            };

            // Preserve thought_signature for Google/Gemini models if present
            // The AI SDK includes it in providerMetadata.google.thoughtSignature
            if ("providerMetadata" in tc && tc.providerMetadata) {
              const providerMetadata = tc.providerMetadata as {
                google?: { thoughtSignature?: string };
              };
              if (providerMetadata?.google?.thoughtSignature) {
                (toolCall as { thought_signature?: string }).thought_signature =
                  providerMetadata.google.thoughtSignature;
              }
            }

            return toolCall;
          });
        }

        const resultObj: ChatCompletionResponse = {
          id: shortUUID.generate(),
          model: responseModel,
          content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
          ...(toolsDisabled ? { toolsDisabled } : {}),
        };
        return resultObj;
      },
      catch: (error: unknown) => {
        const llmError = convertToLLMError(error, providerName);

        const cleanMessage = extractCleanErrorMessage(error);

        // Log clean error message at error level (user-facing)
        void this.logger.error(`LLM Error: ${llmError._tag} - ${cleanMessage}`);

        // Log detailed error information at debug level (for debugging)
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

        void this.logger.debug("LLM Error Details", errorDetails);

        return llmError;
      },
    });
  }

  readonly supportsNativeWebSearch = (
    providerName: ProviderName,
  ): Effect.Effect<boolean, never> => {
    return Effect.succeed(checkProviderNativeWebSearchSupport(providerName, this.logger));
  };

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



    const providerOptions = buildProviderOptions(providerName, options);

    // Message conversion timing
    const messageConversionStart = Date.now();
    const coreMessages = toCoreMessages(options.messages);
    void this.logger.debug(
      `[LLM Timing] Message conversion (${options.messages.length} messages) took ${Date.now() - messageConversionStart}ms`,
    );

    const abortController = new AbortController();

    const responseDeferred = createDeferred<ChatCompletionResponse>();
    void responseDeferred.promise.catch((err) => {
      throw err;
    });



    let processorRef: StreamProcessor | null = null;
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

            const modelInfo = await this.resolveModelInfo(providerName, options.model);
            const {
              tools: requestedTools,
              toolChoice: requestedToolChoice,
              toolsDisabled,
            } = buildToolConfig(
              modelInfo?.supportsTools ?? false,
              options.tools,
              options.toolChoice,
            );

            const tools = this.prepareTools(providerName, requestedTools);

            if (toolsDisabled) {
              void this.logger.info(
                `Tools were provided but skipped because ${options.model} does not support tools`,
              );
            }

            const result = streamText({
              model,
              messages: coreMessages,
              ...(typeof options.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(tools ? { tools } : {}),
              ...(requestedToolChoice ? { toolChoice: requestedToolChoice } : {}),
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
                toolsDisabled,
              },
              emit,
              this.logger,
            );
            processorRef = processor;

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

            const cleanMessage = extractCleanErrorMessage(error);
            // Log clean error message at error level (user-facing)
            void this.logger.error(`LLM Error: ${llmError._tag} - ${cleanMessage}`);
            // Log detailed error information at debug level (for debugging)
            void this.logger.debug("LLM Error Details", errorDetails);

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
        if (processorRef) {
          processorRef.cancel();
        }
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

        const cleanMessage = extractCleanErrorMessage(error);
        // Log clean error message at error level (user-facing)
        void this.logger.error(`LLM Error: ${llmError._tag} - ${cleanMessage}`);
        // Log detailed error information at debug level (for debugging)
        void this.logger.debug("LLM Error Details", errorDetails);

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
        ...(appConfig.web_search ? { webSearchConfig: appConfig.web_search } : {}),
      };
      return new AISDKService(cfg, logger);
    }),
  );
}
