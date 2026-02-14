/* eslint-disable import/order */
import { DEFAULT_MAX_ITERATIONS } from "@/core/constants/agent";
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
import { formatProviderDisplayName, sanitize } from "@/core/utils/string";
import {
  convertToLLMError,
  extractCleanErrorMessage,
  truncateRequestBodyValues,
} from "@/core/utils/llm-error";
import { createDeferred } from "@/core/utils/promise";
import { alibaba, type AlibabaLanguageModelOptions } from "@ai-sdk/alibaba";
import { anthropic, type AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { cerebras } from "@ai-sdk/cerebras";
import { deepseek } from "@ai-sdk/deepseek";
import { fireworks, type FireworksLanguageModelOptions } from "@ai-sdk/fireworks";
import { google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { mistral } from "@ai-sdk/mistral";
import { moonshotai, type MoonshotAILanguageModelOptions } from "@ai-sdk/moonshotai";
import { openai, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { togetherai } from "@ai-sdk/togetherai";
import { xai, type XaiProviderOptions } from "@ai-sdk/xai";
import { minimax } from "vercel-minimax-ai-provider";
import {
  createOpenRouter,
  type OpenRouterProviderOptions,
  type OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
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
import { getMetadataFromMap, getModelsDevMap } from "@/core/utils/models-dev-client";
import { StreamProcessor } from "./stream-processor";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";

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
  providerName?: ProviderName,
): ModelMessage[] {
  const result = messages.map((m) => {
    const role = m.role;
    const content = sanitize(m.content);

    if (role === "system") {
      const msg: SystemModelMessage = {
        role: "system",
        content,
      };
      // Enable prompt caching: the system prompt is stable across turns,
      // so caching it gives cost reduction and latency improvement on the cached prefix
      const normalized = providerName?.toLowerCase();
      if (normalized === "anthropic" || normalized === "ai_gateway") {
        (
          msg as SystemModelMessage & { providerOptions?: Record<string, unknown> }
        ).providerOptions = {
          anthropic: { cacheControl: { type: "ephemeral" } },
        };
      } else if (normalized === "openai") {
        (
          msg as SystemModelMessage & { providerOptions?: Record<string, unknown> }
        ).providerOptions = {
          openai: { promptCacheKey: "system-prompt" },
        };
      } else if (normalized === "openrouter") {
        // OpenRouter supports Anthropic-style prompt caching via its own providerOptions.
        // When routing to Anthropic models (e.g., anthropic/claude-*), this enables cache hits
        // on the system prompt, reducing cost and latency.
        (
          msg as SystemModelMessage & { providerOptions?: Record<string, unknown> }
        ).providerOptions = {
          openrouter: { cacheControl: { type: "ephemeral" } },
        };
      }
      return msg;
    }

    if (role === "user") {
      return {
        role: "user",
        content,
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

      if (content && content.length > 0) {
        contentParts.push({ type: "text", text: content });
      }

      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const toolArgs = sanitize(tc.function.arguments);
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
            input: parseToolArguments(toolArgs),
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
        output: { type: "text", value: content },
      });

      return { role: "tool", content: contentParts } as ToolModelMessage;
    }

    // Fallback - should not reach here
    throw new Error(`Unsupported message role: ${String(role)}`);
  });

  return result;
}

type ModelName = string;
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
type AISDKToolChoice = Parameters<typeof generateText>[0]["toolChoice"];

/**
 * OpenRouter gateway models that are meta-models routing to various underlying models.
 * These should always assume tool support since the underlying models may support them.
 */
const OPENROUTER_GATEWAY_MODELS = new Set(["openrouter/free", "openrouter/auto"]);

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
          tools?: {
            webSearch?: (config?: {
              externalWebAccess?: boolean;
              searchContextSize?: string;
            }) => ToolSet[string];
          };
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
/**
 * Environment variable names for each provider's API key.
 * Used as a fallback when no key is configured in the config file.
 */
const PROVIDER_ENV_VARS: Record<string, string> = {
  alibaba: "ALIBABA_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  minimax: "MINIMAX_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  togetherai: "TOGETHER_AI_API_KEY",
  xai: "XAI_API_KEY",
};

function getConfiguredProviders(
  llmConfig?: LLMConfig,
): { name: ProviderName; apiKey: string; displayName?: string }[] {
  const providers: { name: ProviderName; apiKey: string; displayName?: string }[] = [];
  const addedProviders = new Set<string>();

  if (llmConfig) {
    if (llmConfig.ai_gateway?.api_key) {
      providers.push({
        name: "ai_gateway",
        displayName: "ai gateway",
        apiKey: llmConfig.ai_gateway.api_key,
      });
      addedProviders.add("ai_gateway");
    }
    if (llmConfig.alibaba?.api_key) {
      providers.push({ name: "alibaba", apiKey: llmConfig.alibaba.api_key });
      addedProviders.add("alibaba");
    }
    if (llmConfig.anthropic?.api_key) {
      providers.push({ name: "anthropic", apiKey: llmConfig.anthropic.api_key });
      addedProviders.add("anthropic");
    }
    if (llmConfig.cerebras?.api_key) {
      providers.push({ name: "cerebras", apiKey: llmConfig.cerebras.api_key });
      addedProviders.add("cerebras");
    }
    if (llmConfig.deepseek?.api_key) {
      providers.push({ name: "deepseek", apiKey: llmConfig.deepseek.api_key });
      addedProviders.add("deepseek");
    }
    if (llmConfig.fireworks?.api_key) {
      providers.push({ name: "fireworks", apiKey: llmConfig.fireworks.api_key });
      addedProviders.add("fireworks");
    }
    if (llmConfig.google?.api_key) {
      providers.push({ name: "google", apiKey: llmConfig.google.api_key });
      addedProviders.add("google");
    }
    if (llmConfig.groq?.api_key) {
      providers.push({ name: "groq", apiKey: llmConfig.groq.api_key });
      addedProviders.add("groq");
    }
    if (llmConfig.minimax?.api_key) {
      providers.push({ name: "minimax", apiKey: llmConfig.minimax.api_key });
      addedProviders.add("minimax");
    }
    if (llmConfig.mistral?.api_key) {
      providers.push({ name: "mistral", apiKey: llmConfig.mistral.api_key });
      addedProviders.add("mistral");
    }
    if (llmConfig.moonshotai?.api_key) {
      providers.push({ name: "moonshotai", apiKey: llmConfig.moonshotai.api_key });
      addedProviders.add("moonshotai");
    }
    if (llmConfig.openai?.api_key) {
      providers.push({ name: "openai", apiKey: llmConfig.openai.api_key });
      addedProviders.add("openai");
    }
    if (llmConfig.openrouter?.api_key) {
      providers.push({ name: "openrouter", apiKey: llmConfig.openrouter.api_key });
      addedProviders.add("openrouter");
    }
    if (llmConfig.togetherai?.api_key) {
      providers.push({ name: "togetherai", apiKey: llmConfig.togetherai.api_key });
      addedProviders.add("togetherai");
    }
    if (llmConfig.xai?.api_key) {
      providers.push({ name: "xai", apiKey: llmConfig.xai.api_key });
      addedProviders.add("xai");
    }
  }

  // Fallback: check environment variables for providers not yet configured
  for (const [providerName, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
    if (!addedProviders.has(providerName)) {
      const envKey = process.env[envVar];
      if (envKey) {
        providers.push({ name: providerName as ProviderName, apiKey: envKey });
        addedProviders.add(providerName);
      }
    }
  }

  // Ollama is always available (no API key required)
  if (!addedProviders.has("ollama")) {
    providers.push({ name: "ollama", apiKey: llmConfig?.ollama?.api_key ?? "" });
  }

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
    case "moonshotai":
      model = moonshotai(modelId);
      break;
    case "minimax":
      model = minimax(modelId);
      break;
    case "alibaba":
      model = alibaba(modelId);
      break;
    case "cerebras":
      model = cerebras(modelId);
      break;
    case "fireworks":
      model = fireworks(modelId);
      break;
    case "togetherai":
      model = togetherai(modelId);
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
            systemMessageMode: "system",
            promptCacheKey: "conversation",
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
    case "openrouter": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        // Map Jazz's reasoning_effort to OpenRouter's effort levels
        // Jazz uses: "low" | "medium" | "high" | "disable"
        // OpenRouter uses: "minimal" | "low" | "medium" | "high" | "xhigh" | "none"
        const effortMap: Record<string, "low" | "medium" | "high"> = {
          low: "low",
          medium: "medium",
          high: "high",
        };
        const effort = effortMap[reasoningEffort] ?? "medium";
        return {
          openrouter: {
            reasoning: {
              enabled: true,
              effort,
            },
          } satisfies OpenRouterProviderOptions,
        };
      }
      break;
    }
    case "moonshotai": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        // Moonshot thinking models (kimi-k2-thinking) support budgeted reasoning
        const budgetMap: Record<string, number> = {
          low: 1024,
          medium: 4096,
          high: 16384,
        };
        return {
          moonshotai: {
            thinking: { type: "enabled", budgetTokens: budgetMap[reasoningEffort] ?? 4096 },
            reasoningHistory: "interleaved",
          } satisfies MoonshotAILanguageModelOptions,
        };
      }
      break;
    }
    case "alibaba": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        const budgetMap: Record<string, number> = {
          low: 1024,
          medium: 4096,
          high: 16384,
        };
        return {
          alibaba: {
            enableThinking: true,
            thinkingBudget: budgetMap[reasoningEffort] ?? 4096,
          } satisfies AlibabaLanguageModelOptions,
        };
      }
      break;
    }
    case "cerebras": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        return {
          cerebras: {
            reasoningEffort,
          },
        };
      }
      break;
    }
    case "fireworks": {
      const reasoningEffort = options.reasoning_effort;
      if (reasoningEffort && reasoningEffort !== "disable") {
        const budgetMap: Record<string, number> = {
          low: 1024,
          medium: 4096,
          high: 16384,
        };
        return {
          fireworks: {
            thinking: { type: "enabled", budgetTokens: budgetMap[reasoningEffort] ?? 4096 },
            reasoningHistory: "interleaved",
          } satisfies FireworksLanguageModelOptions,
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
        } else if (name === "moonshotai") {
          // @ai-sdk/moonshotai expects MOONSHOT_API_KEY (not MOONSHOTAI_API_KEY)
          process.env["MOONSHOT_API_KEY"] = apiKey;
        } else if (name === "togetherai") {
          // @ai-sdk/togetherai expects TOGETHER_AI_API_KEY (not TOGETHERAI_API_KEY)
          process.env["TOGETHER_AI_API_KEY"] = apiKey;
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
      return Effect.tryPromise({
        try: async () => {
          const devMap = await getModelsDevMap();
          const resolved: ModelInfo[] = modelSource.models.map((entry) => {
            const dev = getMetadataFromMap(devMap, entry.id, providerName);
            return {
              id: entry.id,
              displayName: entry.displayName ?? entry.id,
              contextWindow: dev?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
              supportsTools: dev?.supportsTools ?? false,
              isReasoningModel: dev?.isReasoningModel ?? false,
              supportsVision: dev?.supportsVision ?? false,
              supportsPdf: dev?.supportsPdf ?? false,
            };
          });
          this.modelInfoCache.set(providerName, resolved);
          return resolved;
        },
        catch: (error) =>
          new LLMConfigurationError({
            provider: providerName,
            message: `Failed to resolve static models from models.dev: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
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
    const models = await Effect.runPromise(
      this.getProviderModels(providerName).pipe(
        Effect.catchAll(() => Effect.succeed([] as readonly ModelInfo[])),
      ),
    );
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
        displayName: formatProviderDisplayName(name),
        configured: configuredNames.has(name),
      }));

    return Effect.succeed(allProviders);
  }

  private prepareTools(
    providerName: ProviderName,
    requestedTools: ChatCompletionOptions["tools"],
  ):
    | { tools: ToolSet; providerNativeToolNames: Set<string>; toolDefinitionChars: number }
    | undefined {
    if (!requestedTools || requestedTools.length === 0) {
      return undefined;
    }

    const toolConversionStart = Date.now();
    const tools: ToolSet = {};
    const providerNativeToolNames = new Set<string>();

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
      // Check if user explicitly selected an external provider (vs "none"/undefined for builtin)
      const selectedExternalProvider = this.config.webSearchConfig?.provider;
      const hasSelectedProviderKey = selectedExternalProvider
        ? !!this.config.webSearchConfig?.[selectedExternalProvider]?.api_key
        : false;

      // Use native if: no external provider selected AND native is available
      // Use external if: external provider is selected AND has API key
      const shouldUseProviderNative = !selectedExternalProvider && providerNativeWebSearch;
      const shouldUseExternal = selectedExternalProvider && hasSelectedProviderKey;

      if (shouldUseProviderNative) {
        void this.logger.debug(
          `[Web Search] Using provider-native web search tool for ${providerName} (builtin selected, no external provider configured)`,
        );
        tools["web_search"] = providerNativeWebSearch;
        providerNativeToolNames.add("web_search");
      } else if (shouldUseExternal) {
        void this.logger.debug(
          `[Web Search] Using Jazz web_search tool with external provider: ${selectedExternalProvider}`,
        );
        // Keep Jazz's web_search tool - it will route to the external provider
      } else if (!providerNativeWebSearch && !shouldUseExternal) {
        void this.logger.debug(
          `[Web Search] web_search tool available but may fail: provider ${providerName} has no native support and no external provider configured`,
        );
        // Keep Jazz's web_search tool but it will return an error when called
      }
    }

    // Estimate tool definition token cost for telemetry
    let toolDefinitionChars = 0;
    for (const toolDef of requestedTools) {
      toolDefinitionChars +=
        toolDef.function.name.length +
        toolDef.function.description.length +
        JSON.stringify(toolDef.function.parameters).length;
    }

    void this.logger.debug(
      `[Tool Telemetry] ${Object.keys(tools).length} tools, ~${toolDefinitionChars} chars (~${Math.ceil(toolDefinitionChars / 4)} tokens est.) sent to ${providerName}`,
    );
    void this.logger.debug(
      `[LLM Timing] Tool conversion (${Object.keys(tools).length} tools) took ${Date.now() - toolConversionStart}ms`,
    );

    return { tools, providerNativeToolNames, toolDefinitionChars };
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
        // OpenRouter gateway models (e.g., openrouter/free) are meta-models that route to various
        // underlying models, so we assume tool support and pass tools through.
        const isGatewayModel = OPENROUTER_GATEWAY_MODELS.has(options.model);
        const supportsTools: boolean = isGatewayModel || (modelInfo?.supportsTools ?? false);
        const {
          tools: requestedTools,
          toolChoice: requestedToolChoice,
          toolsDisabled,
        } = buildToolConfig(supportsTools, options.tools, options.toolChoice);

        const prepared = this.prepareTools(providerName, requestedTools);
        const tools = prepared?.tools;
        const providerNativeToolNames = prepared?.providerNativeToolNames ?? new Set<string>();

        const providerOptions = buildProviderOptions(providerName, options);

        const messageConversionStart = Date.now();
        const coreMessages = toCoreMessages(options.messages, providerName);
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
          stopWhen: stepCountIs(DEFAULT_MAX_ITERATIONS),
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
            ...(usageData.outputTokenDetails?.reasoningTokens != null && {
              reasoningTokens: usageData.outputTokenDetails.reasoningTokens,
            }),
            ...(usageData.inputTokenDetails?.cacheReadTokens != null && {
              cacheReadTokens: usageData.inputTokenDetails.cacheReadTokens,
            }),
            ...(usageData.inputTokenDetails?.cacheWriteTokens != null && {
              cacheWriteTokens: usageData.inputTokenDetails.cacheWriteTokens,
            }),
          };
        }

        // Extract tool calls if present, filtering out provider-native tool calls.
        // Provider-native tools (e.g., OpenAI web search) are handled server-side by the
        // provider during the API call. The results are already embedded in the response
        // content. We must not pass these to Jazz's tool executor.
        if (result.toolCalls && result.toolCalls.length > 0) {
          // Log provider-native tool calls so they're visible to the user
          for (const tc of result.toolCalls) {
            if (providerNativeToolNames.has(tc.toolName)) {
              void this.logger.info(`Provider-native tool used: ${tc.toolName}`, {
                provider: providerName,
                toolName: tc.toolName,
              });
            }
          }

          const filteredToolCalls = result.toolCalls.filter(
            (tc: TypedToolCall<ToolSet>) => !providerNativeToolNames.has(tc.toolName),
          );

          if (filteredToolCalls.length > 0) {
            toolCalls = filteredToolCalls.map((tc: TypedToolCall<ToolSet>) => {
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
        }

        const resultObj: ChatCompletionResponse = {
          id: shortUUID.generate(),
          model: responseModel,
          content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
          ...(toolsDisabled ? { toolsDisabled } : {}),
          ...(prepared
            ? {
                toolDefinitionChars: prepared.toolDefinitionChars,
                toolDefinitionCount: Object.keys(prepared.tools).length,
              }
            : {}),
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
    return Effect.try({
      try: () => {
        const timingStart = Date.now();
        void this.logger.debug(
          `[LLM Timing] ⏱️  Starting streaming completion for ${providerName}:${options.model}`,
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

        const providerOptions = buildProviderOptions(providerName, options);

        // Message conversion timing
        const messageConversionStart = Date.now();
        const coreMessages = toCoreMessages(options.messages, providerName);
        void this.logger.debug(
          `[LLM Timing] Message conversion (${options.messages.length} messages) took ${Date.now() - messageConversionStart}ms`,
        );

        return { timingStart, model, providerOptions, coreMessages };
      },
      catch: (error) => convertToLLMError(error, providerName),
    }).pipe(
      Effect.flatMap(({ timingStart, model, providerOptions, coreMessages }) => {
        const abortController = new AbortController();

        const responseDeferred = createDeferred<ChatCompletionResponse>();

        let processorRef: StreamProcessor | null = null;
        const stream = Stream.async<StreamEvent, LLMError>(
          (
            emit: (
              effect: Effect.Effect<Chunk.Chunk<StreamEvent>, Option.Option<LLMError>>,
            ) => void,
          ) => {
            void (async (): Promise<void> => {
              try {
                const streamTextStart = Date.now();
                void this.logger.debug(
                  `[LLM Timing] 🚀 Calling streamText at +${streamTextStart - timingStart}ms...`,
                );

                const modelInfo = await this.resolveModelInfo(providerName, options.model);
                // OpenRouter gateway models (e.g., openrouter/free) are meta-models that route to various
                // underlying models, so we assume tool support and pass tools through.
                const isGatewayModel = OPENROUTER_GATEWAY_MODELS.has(options.model);
                const supportsTools = isGatewayModel || (modelInfo?.supportsTools ?? false);
                const {
                  tools: requestedTools,
                  toolChoice: requestedToolChoice,
                  toolsDisabled,
                } = buildToolConfig(supportsTools, options.tools, options.toolChoice);

                const prepared = this.prepareTools(providerName, requestedTools);
                const tools = prepared?.tools;

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
                  stopWhen: stepCountIs(DEFAULT_MAX_ITERATIONS),
                });

                void this.logger.debug(
                  `[LLM Timing] ✓ streamText returned (initialization) in ${Date.now() - streamTextStart}ms`,
                );

                const providerNativeToolNames = prepared?.providerNativeToolNames;

                const processor = new StreamProcessor(
                  {
                    providerName,
                    modelName: options.model,
                    hasReasoningEnabled: !!(
                      options.reasoning_effort && options.reasoning_effort !== "disable"
                    ),
                    startTime: Date.now(),
                    toolsDisabled,
                    ...(providerNativeToolNames && { providerNativeToolNames }),
                    ...(prepared
                      ? {
                          toolDefinitionChars: prepared.toolDefinitionChars,
                          toolDefinitionCount: Object.keys(prepared.tools).length,
                        }
                      : {}),
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
              } finally {
                if (processorRef && !abortController.signal.aborted) {
                  processorRef.cancel();
                }
              }
            })();
          },
        );

        return Effect.succeed({
          stream,
          response: Effect.tryPromise({
            try: () => responseDeferred.promise,
            catch: (error) => convertToLLMError(error, providerName),
          }),
          cancel: Effect.sync(() => {
            if (processorRef) {
              processorRef.cancel();
            }
            abortController.abort();
          }),
        });
      }), // close Effect.flatMap
    ); // close pipe
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
