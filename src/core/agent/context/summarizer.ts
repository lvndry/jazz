import { Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import { describeAttachment } from "@/core/types/attachment";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { parseProviderModel } from "@/core/utils/provider-model";
import type { AgentResponse } from "../types";
import { logContextRung } from "./context-telemetry";
import { resolveContextThresholds } from "./context-thresholds";
import { DEFAULT_CONTEXT_WINDOW_MANAGER } from "./context-window-manager";
import { resolveEffectiveContextWindow } from "./effective-context-window";
import { DEFAULT_TOKEN_COUNTER, type ModelHint } from "./token-counter";
import { appendJournalEntry, pruneJournal } from "./work-journal";
import { formatWorkState, readWorkState } from "./work-state";

/** Longest tool-argument string kept verbatim in a summarizer transcript. */
const MAX_RENDERED_ARGUMENT_CHARS = 200;

/**
 * Keep arguments readable without letting one pasted payload dominate the transcript
 * the summarizer has to read.
 */
function truncateArguments(rawArguments: string | undefined): string {
  if (!rawArguments) return "";
  const trimmed = rawArguments.trim();
  if (trimmed.length <= MAX_RENDERED_ARGUMENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_RENDERED_ARGUMENT_CHARS)}… (${trimmed.length} chars)`;
}

/**
 * Fraction of the summarizer's own window its input may occupy, leaving room for the
 * system prompt and the summary it has to write.
 */
const SUMMARIZER_INPUT_BUDGET_RATIO = 0.6;

/**
 * Build the throwaway agent that performs summarization.
 *
 * The parent's window pins (`numCtx`, `maxContextTokens`) are deliberately dropped when
 * the summarizer runs a different model: they describe the parent's runtime, and applying
 * a 200k parent ceiling to an 8k summarizer — or vice versa — is wrong in both directions.
 */
function buildSummarizerAgent(
  parentAgent: Agent,
  summarizerModelConfig: SummarizerModelConfig,
  summarizerModel: `${string}/${string}`,
): Agent {
  const sameModel =
    summarizerModelConfig.provider === parentAgent.config.llmProvider &&
    summarizerModelConfig.model === parentAgent.config.llmModel;

  const {
    numCtx: _numCtx,
    maxContextTokens: _maxContextTokens,
    ...configWithoutWindowPins
  } = parentAgent.config;

  return {
    id: "summarizer",
    name: "Summarizer",
    description: "Background context compressor",
    model: summarizerModel,
    config: {
      ...(sameModel ? parentAgent.config : configWithoutWindowPins),
      llmProvider: summarizerModelConfig.provider,
      llmModel: summarizerModelConfig.model,
      persona: "summarizer",
      tools: [], // No tools—summarizer should only produce text, not use tools
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Split messages into chunks that each fit the summarizer's input budget.
 *
 * A message larger than a whole chunk is kept as its own chunk rather than dropped —
 * the fold below will still see it, and truncation is the transport's problem, not a
 * reason to lose the message entirely.
 */
export function chunkForSummarizer(
  messages: readonly ChatMessage[],
  budgetTokens: number,
  hint: ModelHint,
): ChatMessage[][] {
  if (budgetTokens <= 0) return [[...messages]];

  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const tokens = DEFAULT_TOKEN_COUNTER.countMessage(message, hint);
    if (current.length > 0 && currentTokens + tokens > budgetTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Build a token-counter hint from an agent's provider/model. */
function modelHintFromAgent(agent: Agent): ModelHint {
  return { provider: agent.config.llmProvider, modelId: agent.config.llmModel };
}

interface SummarizerModelConfig {
  provider: ProviderName;
  model: string;
}

/**
 * Choose the model for background summarization.
 *
 * Uses the agent's configured `summarizerModel` ("provider/model") when set and
 * parseable; otherwise falls back to the agent's own provider/model. When a
 * configured value is unusable it returns a `warning` for the caller to log.
 */
export function selectSummarizerModel(parentAgent: Agent): {
  config: SummarizerModelConfig;
  warning?: string;
} {
  const parentConfig: SummarizerModelConfig = {
    provider: parentAgent.config.llmProvider,
    model: parentAgent.config.llmModel,
  };

  const configured: unknown = parentAgent.config.summarizerModel;
  if (configured === undefined || configured === null) {
    return { config: parentConfig };
  }

  if (typeof configured !== "string") {
    return {
      config: parentConfig,
      warning: `Invalid summarizerModel type "${typeof configured}" — falling back to parent model ${parentConfig.provider}/${parentConfig.model}`,
    };
  }

  const parsed = parseProviderModel(configured);
  if (parsed) {
    return { config: parsed };
  }

  return {
    config: parentConfig,
    warning: `Invalid summarizerModel "${configured}" — falling back to parent model ${parentConfig.provider}/${parentConfig.model}`,
  };
}

/**
 * Type for a function that runs an agent recursively (for sub-agent calls).
 * Injected by caller to avoid circular dependency.
 */
export type RecursiveRunner = (options: {
  agent: Agent;
  userInput: string;
  logScope: string;
  conversationId: string;
  maxIterations?: number;
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
   * @param modelContextWindow - Optional model-specific context window size (defaults to 50K)
   */
  /**
   * Split conversation messages into parts for summarization.
   *
   * Separates messages into: system message, messages to summarize (older), and
   * recent messages to keep verbatim. Also sanitizes orphaned tool call/result
   * references from the recent portion to prevent API errors.
   *
   * @param maxTokens - Context window size used to calculate the recent message budget (20%)
   */
  splitMessages(
    currentMessages: ConversationMessages,
    maxTokens: number,
    modelHint?: ModelHint,
  ): {
    systemMessage: ChatMessage;
    priorSummary: ChatMessage | undefined;
    messagesToSummarize: ChatMessage[];
    sanitizedRecentMessages: ChatMessage[];
  } {
    // Keep system message [0] and recent messages that fit in token budget
    const systemMessage = currentMessages[0];

    // A summary from an earlier compaction is prior *state*, not raw history. Feeding
    // it back through the summarizer re-summarizes a summary, and the drift compounds
    // with every cycle. Pull it out here and hand it to the summarizer to merge into.
    const priorSummary = currentMessages[1]?.kind === "summary" ? currentMessages[1] : undefined;
    const hint: ModelHint = modelHint ?? { provider: "", modelId: "" };

    // Reserve 20% of max tokens for recent context
    // This ensures we keep recent context while preventing it from eating the entire window
    const recentTokenBudget = Math.floor(maxTokens * 0.2);
    let accumulatedTokens = 0;
    let recentCount = 0;

    // Scan backwards to fill budget
    for (let i = currentMessages.length - 1; i > 0; i--) {
      const msg = currentMessages[i];
      if (!msg) continue;
      // Calculate tokens for this single message via the calibrated counter.
      const tokens = DEFAULT_TOKEN_COUNTER.countMessage(msg, hint);

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
    const summarizeFrom = priorSummary ? 2 : 1;
    const messagesToSummarize = currentMessages.slice(summarizeFrom, -recentCount);

    // Sanitize recent messages to avoid orphaned tool call/result references.
    // The split may land in the middle of a tool call group, leaving:
    // 1. Tool result messages whose parent assistant tool_call was summarized away
    // 2. Assistant tool_calls whose corresponding tool results were summarized away
    // Either case causes API errors (e.g. OpenAI "No tool call found for function call output").
    const recentToolCallIds = new Set<string>();
    const recentToolResultIds = new Set<string>();
    for (const msg of recentMessages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          recentToolCallIds.add(tc.id);
        }
      }
      if (msg.role === "tool" && msg.tool_call_id) {
        recentToolResultIds.add(msg.tool_call_id);
      }
    }

    const sanitizedRecentMessages = recentMessages.reduce<ChatMessage[]>((acc, msg) => {
      // Drop tool results whose parent assistant tool_call was summarized
      if (msg.role === "tool" && msg.tool_call_id && !recentToolCallIds.has(msg.tool_call_id)) {
        return acc;
      }
      // Strip tool_calls whose results were summarized
      if (msg.role === "assistant" && msg.tool_calls) {
        const keptToolCalls = msg.tool_calls.filter((tc) => recentToolResultIds.has(tc.id));
        if (keptToolCalls.length < msg.tool_calls.length) {
          const { tool_calls: _, ...rest } = msg;
          if (keptToolCalls.length > 0) {
            acc.push({ ...rest, tool_calls: keptToolCalls });
          } else if (rest.content) {
            // Only keep the assistant message if it has text content
            acc.push(rest);
          }
          return acc;
        }
      }
      acc.push(msg);
      return acc;
    }, []);

    return { systemMessage, priorSummary, messagesToSummarize, sanitizedRecentMessages };
  },

  /**
   * Render messages as the transcript handed to the summarizer.
   *
   * Tool call *arguments* are included, not just names. The persona is told to
   * preserve exact file paths and command names; rendering `[Tool Calls: read_file]`
   * stripped precisely those before the summarizer ever saw them, leaving it to
   * describe results without knowing what was asked for.
   */
  renderTranscript(messages: readonly ChatMessage[]): string {
    return messages
      .map((message) => {
        let content = message.content || "";
        // An attachment cannot be summarized — but its path can, and must be. Summarization
        // discards the original messages, so a path that does not reach the summary is gone
        // for good, and with it the model's only way to look at that file again.
        if (message.attachments && message.attachments.length > 0) {
          const described = message.attachments.map(describeAttachment).join(", ");
          content += `\n[Attachments: ${described}]`;
        }
        if (message.tool_calls) {
          const calls = message.tool_calls
            .map((call) => {
              const args = truncateArguments(call.function.arguments);
              return args ? `${call.function.name}(${args})` : call.function.name;
            })
            .join(", ");
          content += `\n[Tool Calls: ${calls}]`;
        }
        return `[${message.role.toUpperCase()}] ${content}`;
      })
      .join("\n\n---\n\n");
  },

  compactIfNeeded(
    currentMessages: ConversationMessages,
    agent: Agent,
    logScope: string,
    conversationId: string,
    runRecursive: RecursiveRunner,
    modelContextWindow?: number,
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
      const presentationService = yield* PresentationServiceTag;
      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig;

      // Use model-specific context window or fall back to default
      const maxTokens = modelContextWindow ?? DEFAULT_CONTEXT_WINDOW_MANAGER.getConfig().maxTokens;
      const hint = modelHintFromAgent(agent);
      // Include the per-request overhead (tool schemas, provider scaffolding) — the
      // window has to hold it too, and ignoring it compacts late.
      const currentTokens =
        DEFAULT_TOKEN_COUNTER.countMessages(currentMessages, hint) +
        DEFAULT_TOKEN_COUNTER.overheadFor(hint);
      const { compactThresholdRatio } = resolveContextThresholds(appConfig.context);
      const threshold = maxTokens * compactThresholdRatio;

      // Check if summarization is needed
      if (currentTokens <= threshold) {
        return currentMessages;
      }

      yield* logger.info("Conversation context approaching limit", {
        currentTokens,
        maxTokens,
        threshold: Math.floor(threshold),
        compactThresholdRatio,
        agentId: agent.id,
        conversationId,
        modelContextWindow,
      });

      yield* presentationService.presentWarning(
        agent.name,
        `Context window ~${Math.round(compactThresholdRatio * 100)}% full of ${maxTokens.toLocaleString()} tokens — auto-compacting conversation history...`,
      );

      yield* logger.info("Compacting history to preserve context...", {
        messageCount: currentMessages.length,
        maxTokens,
      });

      const { systemMessage, priorSummary, messagesToSummarize, sanitizedRecentMessages } =
        Summarizer.splitMessages(currentMessages, maxTokens, hint);

      if (messagesToSummarize.length === 0) {
        // Not enough to summarize, just return as-is
        return currentMessages;
      }

      yield* logger.debug("Summarizing messages from conversation", {
        totalMessages: currentMessages.length,
        messagesToSummarize: messagesToSummarize.length,
        recentKept: sanitizedRecentMessages.length,
      });

      // Summarize the middle portion
      const summaryMessage = yield* Summarizer.summarizeHistory(
        messagesToSummarize,
        agent,
        logScope,
        conversationId,
        runRecursive,
        priorSummary,
      );

      // Rebuild: [system, summary, ...recent]
      const compactedMessages: ConversationMessages = [
        systemMessage,
        summaryMessage,
        ...sanitizedRecentMessages,
      ] as ConversationMessages;

      const newTokens =
        DEFAULT_TOKEN_COUNTER.countMessages(compactedMessages, hint) +
        DEFAULT_TOKEN_COUNTER.overheadFor(hint);

      yield* logger.info("Context compacted successfully", {
        originalMessages: currentMessages.length,
        compactedMessages: compactedMessages.length,
        originalTokens: currentTokens,
        compactedTokens: newTokens,
        tokensSaved: currentTokens - newTokens,
      });

      // Persist before it enters context. From here on this summary is folded into
      // later ones; the journal keeps the version this cycle actually produced.
      yield* appendJournalEntry(agent.id, conversationId, {
        recordedAt: new Date().toISOString(),
        tokensBefore: currentTokens,
        tokensAfter: newTokens,
        messagesBefore: currentMessages.length,
        messagesAfter: compactedMessages.length,
        summary: summaryMessage.content,
      });
      yield* pruneJournal(agent.id, conversationId);

      yield* logContextRung(logger, {
        rung: "compact",
        agentId: agent.id,
        conversationId,
        tokensBefore: currentTokens,
        tokensAfter: newTokens,
        budgetTokens: maxTokens,
        messagesBefore: currentMessages.length,
        messagesAfter: compactedMessages.length,
      });

      yield* presentationService.presentWarning(
        agent.name,
        `Compacted ${currentMessages.length} → ${compactedMessages.length} messages (saved ~${currentTokens - newTokens} tokens)`,
      );

      return compactedMessages;
    });
  },

  /**
   * Summarizes a portion of the conversation history using a specialized sub-agent.
   * Returns a single assistant message containing the summary.
   *
   * Uses the agent's configured `summarizerModel` if set and valid, otherwise
   * falls back to the agent's own provider/model (see `selectSummarizerModel`).
   *
   * @param runRecursive - Injected runner function to execute the summarizer sub-agent
   */
  summarizeHistory(
    messagesToSummarize: ChatMessage[],
    agent: Agent,
    logScope: string,
    conversationId: string,
    runRecursive: RecursiveRunner,
    priorSummary?: ChatMessage,
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

      if (messagesToSummarize.length === 0) {
        return { role: "assistant", content: "No history to summarize." };
      }

      const { config: summarizerModelConfig, warning } = selectSummarizerModel(agent);
      if (warning) {
        yield* logger.warn(warning, { agentId: agent.id });
      }

      yield* logger.debug("Starting background context summarization", {
        messageCount: messagesToSummarize.length,
        conversationId,
        summarizerProvider: summarizerModelConfig.provider,
        summarizerModel: summarizerModelConfig.model,
        parentProvider: agent.config.llmProvider,
        parentModel: agent.config.llmModel,
      });

      // Anything already in task state is durable on disk, so the summary need not carry
      // it. Passing it through lets the summarizer cover what the transcript adds instead.
      const recordedState = formatWorkState(yield* readWorkState(agent.id, conversationId));

      // Define the specialized summarizer agent once, on the fly, with the selected model.
      const summarizerModel =
        `${summarizerModelConfig.provider}/${summarizerModelConfig.model}` as `${string}/${string}`;
      const summarizer = buildSummarizerAgent(agent, summarizerModelConfig, summarizerModel);

      // The transcript can be most of the *parent's* window, which says nothing about
      // what the summarizer's own model can hold. Fold it in chunks when it does not
      // fit, reusing the merge prompt: chunk 1 becomes a summary, each later chunk is
      // merged into it, so the result is one record rather than a pile of fragments.
      const summarizerHint: ModelHint = {
        provider: summarizerModelConfig.provider,
        modelId: summarizerModelConfig.model,
      };
      const summarizerMetadata = yield* Effect.tryPromise({
        try: () =>
          getModelsDevMetadata(summarizerModelConfig.model, summarizerModelConfig.provider),
        catch: () => new Error("Failed to fetch summarizer model metadata"),
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      const summarizerWindow = resolveEffectiveContextWindow({
        provider: summarizerModelConfig.provider,
        ...(summarizerMetadata && { modelMaxTokens: summarizerMetadata.contextWindow }),
      }).tokens;
      const inputBudget = Math.floor(summarizerWindow * SUMMARIZER_INPUT_BUDGET_RATIO);

      const chunks = chunkForSummarizer(messagesToSummarize, inputBudget, summarizerHint);
      if (chunks.length > 1) {
        yield* logger.info("Folding an oversized transcript for the summarizer", {
          chunks: chunks.length,
          inputBudget,
          summarizerWindow,
          summarizerModel: `${summarizerModelConfig.provider}/${summarizerModelConfig.model}`,
        });
      }

      let runningSummary = priorSummary;
      for (const chunk of chunks) {
        const chunkSummary = yield* Summarizer.summarizeChunk(
          chunk,
          summarizer,
          logScope,
          conversationId,
          runRecursive,
          runningSummary,
          recordedState,
        );
        runningSummary = chunkSummary;
      }

      return runningSummary ?? { role: "assistant", content: "No history to summarize." };
    });
  },

  /**
   * Summarize one chunk, merging into `priorSummary` when there is one.
   *
   * Split out from `summarizeHistory` so the fold above can call it per chunk with the
   * summarizer agent already resolved — resolving it once per chunk would re-read config
   * and re-log for no reason.
   */
  summarizeChunk(
    messagesToSummarize: readonly ChatMessage[],
    summarizer: Agent,
    logScope: string,
    conversationId: string,
    runRecursive: RecursiveRunner,
    priorSummary?: ChatMessage,
    recordedState?: string,
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
      const historyText = Summarizer.renderTranscript(messagesToSummarize);

      // What task state already holds is safe on disk. Saying so lets the summary spend
      // its budget on what the transcript adds rather than restating the plan.
      const recordedStateBlock = recordedState
        ? `## Already recorded durably (do not restate)\n\n${recordedState}\n\n` +
          "The above is saved outside this conversation and will survive compaction. Cover " +
          "what the transcript adds beyond it, and flag anywhere the transcript contradicts it.\n\n"
        : "";

      const userInput = priorSummary?.content
        ? "You are updating an existing summary of an ongoing conversation, not writing a new one.\n\n" +
          "Carry forward everything in the existing summary that is still true, fold in what the new transcript adds, and correct anything the new transcript contradicts. Do not drop earlier facts merely because the new transcript does not mention them — they are still the only record of what happened. Output only the updated summary, in the same structure.\n\n" +
          recordedStateBlock +
          `## Existing summary\n\n${priorSummary.content}\n\n## New transcript\n\n${historyText}`
        : "Summarize the following conversation. Produce a concise, structured summary that preserves key information for continuity—goals, decisions, outcomes, key entities, current status, and open questions. Output only the summary.\n\n" +
          recordedStateBlock +
          historyText;

      const summaryResponse = yield* runRecursive({
        agent: summarizer,
        userInput,
        logScope,
        conversationId,
        maxIterations: 1,
      });

      return {
        role: "assistant",
        content: summaryResponse.content,
        kind: "summary",
      };
    });
  },
};
