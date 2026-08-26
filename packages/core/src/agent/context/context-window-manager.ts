import { Effect } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { DEFAULT_TOKEN_COUNTER, type ModelHint, type TokenCounter } from "./token-counter";

/**
 * Configuration for context window management
 */
/**
 * Fraction of the context budget at which the user is told the window is filling up,
 * while there is still room to act on it.
 */
export const CONTEXT_WARN_THRESHOLD_RATIO = 0.7;

/**
 * Fraction of the context budget at which stale tool output is cleared.
 *
 * Below the compaction threshold: clearing is free, so it gets first attempt at
 * reclaiming space before an LLM call is spent summarizing.
 */
export const CONTEXT_CLEAR_THRESHOLD_RATIO = 0.65;

/** Fraction of the context budget at which history is compacted automatically. */
export const CONTEXT_COMPACT_THRESHOLD_RATIO = 0.8;

/**
 * Fraction of the context budget at which history is trimmed outright.
 *
 * Deliberately *above* the compaction threshold. Trimming discards messages without
 * summarizing them, so it must never be the mechanism that normally runs — it is the
 * floor for the cases compaction cannot fix, such as a single tool result too large
 * to summarize around. A trim budget below the compaction threshold silently converts
 * the whole design into a sliding window.
 */
export const CONTEXT_TRIM_THRESHOLD_RATIO = 0.95;

export interface ContextWindowConfig {
  /** Maximum number of tokens to keep in history */
  readonly maxTokens: number;

  /**
   * Total context the run may occupy — the effective model window, already lowered
   * by the agent's own `maxContextTokens` ceiling. Warning and compaction are
   * measured against this, not against `maxTokens`: `maxTokens` is the hard trim
   * budget applied after every LLM turn, and it is deliberately far smaller.
   * Defaults to `maxTokens` for callers that manage a single budget.
   */
  readonly contextBudgetTokens?: number;

  /** Fraction of the budget that triggers a warning. Default {@link CONTEXT_WARN_THRESHOLD_RATIO}. */
  readonly warnThresholdRatio?: number;

  /** Fraction of the budget that triggers compaction. Default {@link CONTEXT_COMPACT_THRESHOLD_RATIO}. */
  readonly compactThresholdRatio?: number;

  /** Fraction of the budget that triggers tool-result clearing. Default {@link CONTEXT_CLEAR_THRESHOLD_RATIO}. */
  readonly clearThresholdRatio?: number;

  /**
   * Number of recent turns to always keep intact (never trim).
   * A turn is a user message plus all subsequent assistant/tool messages
   * until the next user message. This ensures complete interaction cycles
   * (including all tool calls) are preserved.
   * Default: 2
   */
  readonly protectedRecentTurns?: number;

  /**
   * Optional token counter override. Defaults to DEFAULT_TOKEN_COUNTER which
   * uses gpt-tokenizer for OpenAI families and per-model calibration for the
   * rest. Tests can inject a fake to assert deterministic behavior.
   */
  readonly tokenCounter?: TokenCounter;

  /**
   * Optional model hint used for token counting. When omitted, counts fall
   * back to the family-default ratio for an unknown family (≈ 4 chars/token).
   * The agent runner provides this from the active provider+model.
   */
  readonly modelHint?: ModelHint;
}

/**
 * Result of a trim operation
 */
export interface TrimResult {
  readonly originalCount: number;
  readonly trimmedCount: number;
  readonly messagesRemoved: number;
  /** Total request tokens after trimming, including per-request overhead. */
  readonly estimatedTokens: number;
  /** Total request tokens before trimming, for measuring what the rung reclaimed. */
  readonly estimatedTokensBefore: number;
}

/**
 * Index at which the protected recent zone begins.
 *
 * A turn starts at a "user" message and runs through every assistant/tool message
 * until the next one, so protecting whole turns keeps tool calls with their results
 * instead of severing them. Shared by trimming and tool-result clearing so both agree
 * on what counts as recent — a clearing pass that reached further back than trimming
 * would strip results the protected zone was meant to keep intact.
 *
 * Returns `messages.length` when there is nothing to protect.
 */
export function protectedZoneStartIndex(
  messages: readonly ChatMessage[],
  protectedTurns: number,
): number {
  let turnsFound = 0;
  for (let index = messages.length - 1; index >= 1; index--) {
    if (messages[index]?.role === "user") {
      turnsFound++;
      if (turnsFound >= protectedTurns) return index;
    }
  }

  // Fewer complete turns than requested: protect from the earliest user message.
  if (turnsFound > 0) {
    for (let index = 1; index < messages.length; index++) {
      if (messages[index]?.role === "user") return index;
    }
  }

  return messages.length;
}

/** Default model hint when the caller does not supply one (legacy callers). */
const FALLBACK_MODEL_HINT: ModelHint = { provider: "", modelId: "" };

/**
 * Manages conversation context window to prevent unbounded growth
 * while preserving message integrity (tool calls, system prompts, etc.)
 */
export class ContextWindowManager {
  private readonly counter: TokenCounter;
  private readonly modelHint: ModelHint;

  constructor(private readonly config: ContextWindowConfig) {
    this.counter = config.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
    this.modelHint = config.modelHint ?? FALLBACK_MODEL_HINT;
  }

  /**
   * Calculate total tokens for a list of messages, routed through the
   * configured TokenCounter (provider-native tokenizer when available,
   * calibrated heuristic otherwise).
   */
  calculateTotalTokens(messages: ChatMessage[]): number {
    return this.counter.countMessages(messages, this.modelHint);
  }

  /**
   * Trim message history to fit within context window limits.
   * Returns a new array of messages and the trim metadata.
   * Preserves system message, protected recent messages, and ensures tool call/result pairing.
   */
  trim(
    messages: ConversationMessages,
    logger: LoggerService,
    agentId: string,
    conversationId: string,
  ): Effect.Effect<
    { messages: ConversationMessages; result: TrimResult | undefined },
    never,
    LoggerService | AgentConfigService
  > {
    const overheadTokens = this.requestOverheadTokens();
    const currentTokens = this.calculateTotalTokens(messages) + overheadTokens;
    if (currentTokens <= this.config.maxTokens) {
      return Effect.succeed({ messages, result: undefined });
    }

    const originalLength = messages.length;
    const protectedTurns = this.config.protectedRecentTurns ?? 2;
    const protectedStartIndex = protectedZoneStartIndex(messages, protectedTurns);

    const protectedIndices = new Set<number>();
    for (let i = protectedStartIndex; i < messages.length; i++) {
      protectedIndices.add(i);
    }

    // Step 2: Build tool call ID map
    const toolCallToAssistant = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallToAssistant.set(tc.id, i);
        }
      }
    }

    // Step 3: Calculate tokens for system message and protected zone
    const systemTokens = this.counter.countMessage(messages[0], this.modelHint) + overheadTokens;
    let protectedTokens = 0;
    for (const idx of protectedIndices) {
      const msg = messages[idx];
      if (msg) {
        protectedTokens += this.counter.countMessage(msg, this.modelHint);
      }
    }

    // Step 4: Scan backwards from the message before protected zone to collect messages until limit reached
    const recentIndices: number[] = [];
    let accumulatedTokens = systemTokens + protectedTokens;

    for (let i = protectedStartIndex - 1; i >= 1; i--) {
      const msg = messages[i];
      if (!msg) continue;

      const tokens = this.counter.countMessage(msg, this.modelHint);

      if (accumulatedTokens + tokens > this.config.maxTokens) {
        break;
      }

      recentIndices.push(i);
      accumulatedTokens += tokens;
    }

    // Reverse to get chronological order [oldest ... newest]
    recentIndices.reverse();

    // Step 5: Validate tool integrity for non-protected messages
    const keptSet = new Set([0, ...recentIndices, ...protectedIndices]);
    const finalIndices: number[] = [0]; // Always keep system

    // Process non-protected messages (validate tool integrity)
    for (const idx of recentIndices) {
      const msg = messages[idx];
      if (!msg) continue;

      if (msg.role === "tool" && msg.tool_call_id) {
        const assistantIdx = toolCallToAssistant.get(msg.tool_call_id);
        if (assistantIdx === undefined || !keptSet.has(assistantIdx)) {
          continue; // Drop orphan result
        }
      }
      finalIndices.push(idx);
    }

    // Add all protected messages (always kept intact)
    for (const idx of protectedIndices) {
      finalIndices.push(idx);
    }

    // Sort to maintain chronological order
    finalIndices.sort((a, b) => a - b);

    // Step 6: Rebuild messages array
    const keptMessages: ChatMessage[] = finalIndices.map((i) => messages[i] as ChatMessage);

    // Structural guarantee: finalIndices always contains 0,
    // and messages is ConversationMessages, so messages[0] exists.
    const resultMessages: ConversationMessages = [
      keptMessages[0],
      ...keptMessages.slice(1),
    ] as ConversationMessages;

    const trimResult: TrimResult = {
      originalCount: originalLength,
      trimmedCount: resultMessages.length,
      messagesRemoved: originalLength - resultMessages.length,
      estimatedTokens: this.totalRequestTokens(resultMessages),
      estimatedTokensBefore: currentTokens,
    };

    return logger
      .warn("Message history trimmed", {
        agentId,
        conversationId,
        limits: {
          maxTokens: this.config.maxTokens,
          protectedRecentTurns: protectedTurns,
        },
        originalCount: trimResult.originalCount,
        trimmedCount: trimResult.trimmedCount,
        estimatedTokens: trimResult.estimatedTokens,
      })
      .pipe(Effect.map(() => ({ messages: resultMessages, result: trimResult })));
  }

  /**
   * Check if messages need trimming
   */
  needsTrimming(messages: ChatMessage[]): boolean {
    return this.totalRequestTokens(messages) > this.config.maxTokens;
  }

  /** Total context this run may occupy, after the agent's own ceiling. */
  get contextBudgetTokens(): number {
    return this.config.contextBudgetTokens ?? this.config.maxTokens;
  }

  /** Token count above which the user is warned the window is filling up. */
  get warnThresholdTokens(): number {
    const ratio = this.config.warnThresholdRatio ?? CONTEXT_WARN_THRESHOLD_RATIO;
    return Math.floor(this.contextBudgetTokens * ratio);
  }

  /** Token count above which stale tool results are cleared. */
  get clearThresholdTokens(): number {
    const ratio = this.config.clearThresholdRatio ?? CONTEXT_CLEAR_THRESHOLD_RATIO;
    return Math.floor(this.contextBudgetTokens * ratio);
  }

  /** True once the conversation passes the tool-result clearing threshold. */
  shouldClearToolResults(messages: ChatMessage[]): boolean {
    return this.totalRequestTokens(messages) > this.clearThresholdTokens;
  }

  /** Token count above which history is compacted. */
  get compactThresholdTokens(): number {
    return Math.floor(this.contextBudgetTokens * this.thresholdRatios.compactThresholdRatio);
  }

  /** The resolved ratios, so callers can describe them without re-deriving defaults. */
  get thresholdRatios(): { warnThresholdRatio: number; compactThresholdRatio: number } {
    return {
      warnThresholdRatio: this.config.warnThresholdRatio ?? CONTEXT_WARN_THRESHOLD_RATIO,
      compactThresholdRatio: this.config.compactThresholdRatio ?? CONTEXT_COMPACT_THRESHOLD_RATIO,
    };
  }

  /**
   * Tokens every request carries beyond the messages — tool schemas above all.
   *
   * Counting messages alone understates a request by 10-30k once MCP servers are
   * attached, which is the difference between compacting at 80% and discovering
   * the window was already full.
   */
  requestOverheadTokens(): number {
    return this.counter.overheadFor?.(this.modelHint) ?? 0;
  }

  /** Messages plus the per-request overhead: what the window actually has to hold. */
  totalRequestTokens(messages: ChatMessage[]): number {
    return this.calculateTotalTokens(messages) + this.requestOverheadTokens();
  }

  /**
   * Where this conversation sits inside the budget, so callers can warn, compact,
   * or report usage from one shared accounting.
   */
  usage(messages: ChatMessage[]): {
    currentTokens: number;
    messageTokens: number;
    overheadTokens: number;
    budgetTokens: number;
    ratio: number;
    shouldWarn: boolean;
    shouldCompact: boolean;
  } {
    const messageTokens = this.calculateTotalTokens(messages);
    const overheadTokens = this.requestOverheadTokens();
    const currentTokens = messageTokens + overheadTokens;
    const budgetTokens = this.contextBudgetTokens;
    return {
      currentTokens,
      messageTokens,
      overheadTokens,
      budgetTokens,
      ratio: budgetTokens > 0 ? currentTokens / budgetTokens : 0,
      shouldWarn: currentTokens > this.warnThresholdTokens,
      shouldCompact: currentTokens > this.compactThresholdTokens,
    };
  }

  /** True once the conversation passes the warn threshold but before compaction. */
  shouldWarn(messages: ChatMessage[]): boolean {
    return this.totalRequestTokens(messages) > this.warnThresholdTokens;
  }

  /** True once the conversation passes the compaction threshold. */
  shouldCompact(messages: ChatMessage[]): boolean {
    return this.totalRequestTokens(messages) > this.compactThresholdTokens;
  }

  /**
   * Check if messages should be summarized.
   *
   * @deprecated Use {@link shouldCompact}, which measures against the context
   * budget rather than the trim budget.
   */
  shouldSummarize(messages: ChatMessage[]): boolean {
    return this.shouldCompact(messages);
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextWindowConfig {
    return { ...this.config };
  }
}

/**
 * Default context window manager with 50K token limit
 */
export const DEFAULT_CONTEXT_WINDOW_MANAGER = new ContextWindowManager({
  maxTokens: 50_000,
  protectedRecentTurns: 3,
});
