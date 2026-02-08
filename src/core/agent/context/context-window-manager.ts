import { Effect } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";

/**
 * Configuration for context window management
 */
export interface ContextWindowConfig {
  /** Maximum number of tokens to keep in history */
  readonly maxTokens: number;

  /**
   * Number of recent turns to always keep intact (never trim).
   * A turn is a user message plus all subsequent assistant/tool messages
   * until the next user message. This ensures complete interaction cycles
   * (including all tool calls) are preserved.
   * Default: 2
   */
  readonly protectedRecentTurns?: number;
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
  private tokenCache = new WeakMap<ChatMessage, number>();

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
   * Get cached token count for a message, computing if not cached.
   * Uses WeakMap so messages removed during trimming are automatically cleaned up.
   */
  private estimateTokensCached(message: ChatMessage): number {
    const cached = this.tokenCache.get(message);
    if (cached !== undefined) return cached;

    const tokens = this.estimateTokens(message);
    this.tokenCache.set(message, tokens);
    return tokens;
  }

  /**
   * Calculate total estimated tokens for a list of messages
   */
  calculateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((acc, msg) => acc + this.estimateTokensCached(msg), 0);
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
    const currentTokens = this.calculateTotalTokens(messages);
    if (currentTokens <= this.config.maxTokens) {
      return Effect.succeed({ messages, result: undefined });
    }

    const originalLength = messages.length;
    const protectedTurns = this.config.protectedRecentTurns ?? 2;

    // Step 1: Identify protected zone — last N complete turns.
    // A turn starts at each "user" message and includes all subsequent
    // assistant/tool messages until the next user message.
    // Scan backwards to find the start index of the Nth-from-last turn.
    let turnsFound = 0;
    let protectedStartIndex = messages.length; // nothing protected yet
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i]?.role === "user") {
        turnsFound++;
        if (turnsFound >= protectedTurns) {
          protectedStartIndex = i;
          break;
        }
      }
    }
    // If we didn't find enough turns, protect from index 1 (after system)
    if (turnsFound < protectedTurns && turnsFound > 0) {
      // Find the earliest user message (after system)
      for (let i = 1; i < messages.length; i++) {
        if (messages[i]?.role === "user") {
          protectedStartIndex = i;
          break;
        }
      }
    }

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
    const systemTokens = this.estimateTokensCached(messages[0]);
    let protectedTokens = 0;
    for (const idx of protectedIndices) {
      const msg = messages[idx];
      if (msg) {
        protectedTokens += this.estimateTokensCached(msg);
      }
    }

    // Step 4: Scan backwards from the message before protected zone to collect messages until limit reached
    const recentIndices: number[] = [];
    let accumulatedTokens = systemTokens + protectedTokens;

    for (let i = protectedStartIndex - 1; i >= 1; i--) {
      const msg = messages[i];
      if (!msg) continue;

      const tokens = this.estimateTokensCached(msg);

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
      estimatedTokens: this.calculateTotalTokens(resultMessages),
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
    return this.calculateTotalTokens(messages) > this.config.maxTokens;
  }

  /**
   * Check if messages should be summarized (80% of token limit)
   * This provides early warning before hitting the hard limit
   */
  shouldSummarize(messages: ChatMessage[]): boolean {
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
 * Default context window manager with 50K token limit
 */
export const DEFAULT_CONTEXT_WINDOW_MANAGER = new ContextWindowManager({
  maxTokens: 50_000,
  protectedRecentTurns: 3,
});
