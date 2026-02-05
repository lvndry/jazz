import { Effect } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LLMServiceTag } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ProviderName } from "@/core/constants/models";
import type { Agent } from "@/core/types";
import type { LLMConfig } from "@/core/types/config";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { getMetadataFromMap, getModelsDevMap } from "@/services/llm/models-dev-client";
import { DEFAULT_CONTEXT_WINDOW_MANAGER } from "./context-window-manager";
import type { AgentResponse } from "../types";

/**
 * Fallback cheap models for each static provider if models.dev lookup fails.
 */
const FALLBACK_CHEAP_MODELS: Partial<Record<ProviderName, string>> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  google: "gemini-2.0-flash-lite",
  mistral: "ministral-3b-latest",
  xai: "grok-2-mini",
  deepseek: "deepseek-chat",
};

/**
 * Static providers that support model selection for summarization.
 */
const STATIC_PROVIDERS = new Set<ProviderName>([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "xai",
  "deepseek",
]);

interface SummarizerModelConfig {
  provider: ProviderName;
  model: string;
}

/**
 * Find the cheapest model for a given provider using models.dev pricing data.
 */
async function findCheapestModelForProvider(
  provider: string,
  availableModels: readonly string[],
): Promise<string | null> {
  try {
    const modelsDevMap = await getModelsDevMap();
    if (!modelsDevMap) return null;

    let cheapestModel: string | null = null;
    let lowestCost = Infinity;

    for (const modelId of availableModels) {
      const meta = getMetadataFromMap(modelsDevMap, modelId, provider);
      if (meta?.inputPricePerMillion !== undefined && meta?.outputPricePerMillion !== undefined) {
        // Use average of input/output price as cost metric
        const avgCost = (meta.inputPricePerMillion + meta.outputPricePerMillion) / 2;
        if (avgCost < lowestCost) {
          lowestCost = avgCost;
          cheapestModel = modelId;
        }
      }
    }

    return cheapestModel;
  } catch {
    return null; // Fallback to hardcoded on any error
  }
}

/**
 * Select the best model for summarization based on cost priority.
 *
 * Priority order:
 * 1. OpenRouter free tier if configured
 * 2. Cheapest model from parent provider (via models.dev pricing)
 * 3. Fallback to hardcoded cheap models for static providers
 * 4. Parent agent's model (for dynamic providers like ollama, groq)
 */
function selectSummarizerModel(
  parentAgent: Agent,
  llmConfig: LLMConfig | undefined,
): Effect.Effect<SummarizerModelConfig, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;

    // Priority 1: OpenRouter free tier if configured
    if (llmConfig?.openrouter?.api_key) {
      return { provider: "openrouter" as ProviderName, model: "openrouter/free" };
    }

    // Get parent provider
    const parentProvider = parentAgent.config.llmProvider;

    // Priority 2 & 3: For static providers, try to find cheapest model
    if (STATIC_PROVIDERS.has(parentProvider)) {
      // Try to get available models for this provider
      const providerInfoResult = yield* llmService
        .getProvider(parentProvider)
        .pipe(Effect.either);

      if (providerInfoResult._tag === "Right") {
        const providerInfo = providerInfoResult.right;
        const modelIds = providerInfo.supportedModels.map((m) => m.id);

        // Try models.dev lookup for cheapest model
        const cheapestModel = yield* Effect.promise(() =>
          findCheapestModelForProvider(parentProvider, modelIds),
        );

        if (cheapestModel) {
          return { provider: parentProvider, model: cheapestModel };
        }
      }

      // Fallback to hardcoded cheap models if models.dev lookup failed
      const fallbackModel = FALLBACK_CHEAP_MODELS[parentProvider];
      if (fallbackModel) {
        return { provider: parentProvider, model: fallbackModel };
      }
    }

    // Priority 4: Use parent model for dynamic providers (ollama, groq, etc.)
    return {
      provider: parentAgent.config.llmProvider,
      model: parentAgent.config.llmModel,
    };
  });
}

/**
 * Type for a function that runs an agent recursively (for sub-agent calls).
 * Injected by caller to avoid circular dependency.
 */
export type RecursiveRunner = (options: {
  agent: Agent;
  userInput: string;
  sessionId: string;
  conversationId: string;
  maxIterations: number;
}) => Effect.Effect<
  AgentResponse,
  Error,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
>;

/**
 * Context summarization utilities.
 *
 * This module handles proactive context window management to prevent
 * hitting the model's token limit by summarizing old messages.
 */
export const Summarizer = {
  /**
   * Proactively check if context needs compaction and summarize if necessary.
   * This prevents hitting the model's context window limit by summarizing old messages.
   *
   * @param runRecursive - Injected runner function to execute the summarizer sub-agent
   */
  compactIfNeeded(
    currentMessages: ConversationMessages,
    agent: Agent,
    sessionId: string,
    conversationId: string,
    runRecursive: RecursiveRunner,
  ): Effect.Effect<
    ConversationMessages,
    Error,
    | LLMService
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | PresentationService
    | ToolRequirements
  > {
    return Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;

      // Check if summarization is needed
      if (!DEFAULT_CONTEXT_WINDOW_MANAGER.shouldSummarize(currentMessages)) {
        return currentMessages;
      }

      const currentTokens = DEFAULT_CONTEXT_WINDOW_MANAGER.calculateTotalTokens(currentMessages);
      const maxTokens = DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().maxTokens || 150_000;

      yield* logger.info("Conversation context approaching limit", {
        currentTokens,
        maxTokens,
        threshold: Math.floor(maxTokens * 0.8),
        agentId: agent.id,
        conversationId,
      });

      yield* logger.info("Compacting history to preserve context...", {
        messageCount: currentMessages.length,
      });

      // Keep system message [0] and recent messages that fit in token budget
      const systemMessage = currentMessages[0];

      // Reserve 20% of max tokens for recent context
      // This ensures we keep recent context while preventing it from eating the entire window
      const recentTokenBudget = Math.floor(maxTokens * 0.2);
      let accumulatedTokens = 0;
      let recentCount = 0;

      // Scan backwards to fill budget
      for (let i = currentMessages.length - 1; i > 0; i--) {
        const msg = currentMessages[i];
        if (!msg) continue;
        // Calculate tokens for this single message
        const tokens = DEFAULT_CONTEXT_WINDOW_MANAGER.calculateTotalTokens([msg]);

        // Stop if adding this message exceeds budget, unless it's the very first one we're checking
        // (we always want to keep at least 1 recent message even if it's large, though extremely large messages are risky)
        if (accumulatedTokens + tokens > recentTokenBudget && recentCount > 0) {
          break;
        }

        accumulatedTokens += tokens;
        recentCount++;
      }

      // Always keep at least the last message
      recentCount = Math.max(1, recentCount);
      // But don't exceed total messages available to separate
      recentCount = Math.min(recentCount, currentMessages.length - 1);

      const recentMessages = currentMessages.slice(-recentCount);
      const messagesToSummarize = currentMessages.slice(1, -recentCount);

      if (messagesToSummarize.length === 0) {
        // Not enough to summarize, just return as-is
        return currentMessages;
      }

      yield* logger.debug("Summarizing messages from conversation", {
        totalMessages: currentMessages.length,
        messagesToSummarize: messagesToSummarize.length,
        recentKept: recentCount,
      });

      // Summarize the middle portion
      const summaryMessage = yield* Summarizer.summarizeHistory(
        messagesToSummarize,
        agent,
        sessionId,
        conversationId,
        runRecursive,
      );

      // Rebuild: [system, summary, ...recent]
      const compactedMessages: ConversationMessages = [
        systemMessage,
        summaryMessage,
        ...recentMessages,
      ] as ConversationMessages;

      const newTokens = DEFAULT_CONTEXT_WINDOW_MANAGER.calculateTotalTokens(compactedMessages);

      yield* logger.info("Context compacted successfully", {
        originalMessages: currentMessages.length,
        compactedMessages: compactedMessages.length,
        originalTokens: currentTokens,
        compactedTokens: newTokens,
        tokensSaved: currentTokens - newTokens,
      });

      return compactedMessages;
    });
  },

  /**
   * Summarizes a portion of the conversation history using a specialized sub-agent.
   * Returns a single assistant message containing the summary.
   *
   * Uses a cheaper model for summarization when available:
   * - OpenRouter free tier if configured
   * - Cheapest model from parent provider (via models.dev pricing)
   * - Fallback to hardcoded cheap models for static providers
   * - Parent agent's model for dynamic providers (ollama, groq, etc.)
   *
   * @param runRecursive - Injected runner function to execute the summarizer sub-agent
   */
  summarizeHistory(
    messagesToSummarize: ChatMessage[],
    agent: Agent,
    sessionId: string,
    conversationId: string,
    runRecursive: RecursiveRunner,
  ): Effect.Effect<
    ChatMessage,
    Error,
    | LLMService
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | PresentationService
    | ToolRequirements
  > {
    return Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      const configService = yield* AgentConfigServiceTag;

      if (messagesToSummarize.length === 0) {
        return { role: "assistant", content: "No history to summarize." };
      }

      // Get LLM config for model selection
      const appConfig = yield* configService.appConfig;
      const llmConfig = appConfig.llm;

      // Select cheaper model for summarization
      const summarizerModelConfig = yield* selectSummarizerModel(agent, llmConfig);

      yield* logger.debug("Starting background context summarization", {
        messageCount: messagesToSummarize.length,
        conversationId,
        summarizerProvider: summarizerModelConfig.provider,
        summarizerModel: summarizerModelConfig.model,
        parentProvider: agent.config.llmProvider,
        parentModel: agent.config.llmModel,
      });

      const historyText = messagesToSummarize
        .map((m) => {
          let content = m.content || "";
          if (m.tool_calls) {
            content += `\n[Tool Calls: ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]`;
          }
          return `[${m.role.toUpperCase()}] ${content}`;
        })
        .join("\n\n---\n\n");

      // Define specialized summarizer agent on the fly with cheaper model
      const summarizerModel = `${summarizerModelConfig.provider}/${summarizerModelConfig.model}` as `${string}/${string}`;
      const summarizer: Agent = {
        id: "summarizer",
        name: "Summarizer",
        description: "Background context compressor",
        model: summarizerModel,
        config: {
          ...agent.config,
          llmProvider: summarizerModelConfig.provider,
          llmModel: summarizerModelConfig.model,
          agentType: "summarizer",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const summaryResponse = yield* runRecursive({
        agent: summarizer,
        userInput: historyText,
        sessionId,
        conversationId,
        maxIterations: 1,
      });

      return {
        role: "assistant",
        content: summaryResponse.content,
      };
    });
  },
};
