import { Effect } from "effect";
import type { AgentConfigService } from "../interfaces/agent-config";
import type { LoggerService } from "../interfaces/logger";
import type { ChatMessage, ConversationMessages } from "../types/message";

/**
 * Configuration for context window management
 */
export interface ContextWindowConfig {
  /** Maximum number of tokens to keep in history (heuristic) */
  readonly maxTokens?: number;

  /** Maximum number of messages to keep in history */
  readonly maxMessages: number;

  /** Strategy for trimming messages */
  readonly strategy?: "recent" | "semantic" | "token-based";
}

/**
 * Result of a trim operation
 */
export interface TrimResult {
  readonly originalCount: number;
  readonly trimmedCount: number;
  readonly messagesRemoved: number;
  readonly estimatedTokens: number;
}

/**
 * Manages conversation context window to prevent unbounded growth
 * while preserving message integrity (tool calls, system prompts, etc.)
 */
export class ContextWindowManager {
  constructor(private readonly config: ContextWindowConfig) {}

  /**
   * Estimate token count for a message (heuristic: ~4 chars per token)
   */
  private estimateTokens(message: ChatMessage): number {
    let contentTokens = 0;
    if (message.content) {
      contentTokens = Math.ceil(message.content.length / 4);
    }

    let toolTokens = 0;
    if (message.tool_calls) {
      // Rough estimation for tool calls
      toolTokens = Math.ceil(JSON.stringify(message.tool_calls).length / 4);
    } else if (message.role === "tool" && message.tool_call_id) {
      // Tool result tokens are covered by content, but add overhead
      toolTokens = 10;
    }

    // Base overhead per message
    return contentTokens + toolTokens + 4;
  }

  /**
   * Calculate total estimated tokens for a list of messages
   */
  calculateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((acc, msg) => acc + this.estimateTokens(msg), 0);
  }

  /**
   * Trim message history to fit within context window limits.
   * Returns a new array of messages and the trim metadata.
   * Preserves system message and ensures tool call/result pairing.
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
    const currentTokens = this.config.maxTokens ? this.calculateTotalTokens(messages) : 0;
    const needsTokenTrim =
      this.config.maxTokens !== undefined && currentTokens > this.config.maxTokens;
    const needsMessageTrim = messages.length > this.config.maxMessages;

    if (!needsMessageTrim && !needsTokenTrim) {
      return Effect.succeed({ messages, result: undefined });
    }

    const originalLength = messages.length;

    // Step 1: Build tool call ID map
    const toolCallToAssistant = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallToAssistant.set(tc.id, i);
        }
      }
    }

    // Step 2: Determine valid trimming candidates (keeping system msg at index 0)
    const systemTokens = this.estimateTokens(messages[0]);

    // Scan backwards from end to collect messages until limit reached
    const recentIndices: number[] = [];
    let accumulatedTokens = systemTokens;
    let accumulatedMessages = 1; // System message

    for (let i = messages.length - 1; i >= 1; i--) {
      const msg = messages[i];
      if (!msg) continue;

      const tokens = this.estimateTokens(msg);

      // Check limits
      const willExceedMessages = accumulatedMessages + 1 > this.config.maxMessages;
      const willExceedTokens =
        this.config.maxTokens !== undefined && accumulatedTokens + tokens > this.config.maxTokens;

      if (willExceedMessages || willExceedTokens) {
        break;
      }

      recentIndices.push(i);
      accumulatedTokens += tokens;
      accumulatedMessages += 1;
    }

    // Reverse to get chronological order [oldest ... newest]
    recentIndices.reverse();

    // Step 3: Validate tool integrity
    const keptSet = new Set([0, ...recentIndices]);
    const finalIndices: number[] = [0]; // Always keep system

    // Process recent messages
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

    // Step 4: Rebuild messages array
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
      estimatedTokens: this.calculateTotalTokens(resultMessages),
    };

    return logger
      .warn("Message history trimmed", {
        agentId,
        conversationId,
        limits: { maxMessages: this.config.maxMessages, maxTokens: this.config.maxTokens },
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
    if (messages.length > this.config.maxMessages) return true;
    if (this.config.maxTokens) {
      return this.calculateTotalTokens(messages) > this.config.maxTokens;
    }
    return false;
  }

  /**
   * Check if messages should be summarized (80% of token limit)
   * This provides early warning before hitting the hard limit
   */
  shouldSummarize(messages: ChatMessage[]): boolean {
    if (!this.config.maxTokens) return false;

    const currentTokens = this.calculateTotalTokens(messages);
    const threshold = this.config.maxTokens * 0.8; // 80% threshold

    return currentTokens > threshold;
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextWindowConfig {
    return { ...this.config };
  }
}

/**
 * Default context window manager with 200 message limit
 */
export const DEFAULT_CONTEXT_WINDOW_MANAGER = new ContextWindowManager({
  maxMessages: 200,
  maxTokens: 150000,
  strategy: "token-based",
});
