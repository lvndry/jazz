import { Effect } from "effect";
import type { AgentConfigService } from "../interfaces/agent-config";
import type { LoggerService } from "../interfaces/logger";
import type { ChatMessage } from "../types/message";

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
   * Trim message history in-place to fit within context window limits.
   * Preserves system message and ensures tool call/result pairing.
   */
  trim(
    messages: ChatMessage[],
    logger: LoggerService,
    agentId: string,
    conversationId: string,
  ): Effect.Effect<TrimResult | void, never, LoggerService | AgentConfigService> {
    const currentTokens = this.config.maxTokens ? this.calculateTotalTokens(messages) : 0;
    const needsTokenTrim =
      this.config.maxTokens !== undefined && currentTokens > this.config.maxTokens;
    const needsMessageTrim = messages.length > this.config.maxMessages;

    if (!needsMessageTrim && !needsTokenTrim) {
      return Effect.void;
    }

    const originalLength = messages.length;

    // Step 1: Build tool call ID map
    // Map tool_call_id -> index of assistant message that created it
    const toolCallToAssistant = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallToAssistant.set(tc.id, i);
        }
      }
    }

    // Step 2: Determine valid trimming candidates (keeping system msg)
    // We trim from the BEGINNING (after system), keeping recent messages.
    // So we need to find the split point where remaining messages fit limits.

    // Always keep index 0 (system)
    const systemTokens = messages[0] ? this.estimateTokens(messages[0]) : 0;

    let keptIndices: number[] = [];
    if (messages.length > 0) keptIndices.push(0);

    // Scan backwards from end to collect messages until limit reached
    const recentIndices: number[] = [];
    let accumulatedTokens = systemTokens;
    let accumulatedMessages = 1; // System message

    for (let i = messages.length - 1; i >= 1; i--) {
      const msg = messages[i];
      if (!msg) continue; // Should not happen

      const tokens = this.estimateTokens(msg);

      // Check limits
      const willExceedMessages = accumulatedMessages + 1 > this.config.maxMessages;
      const willExceedTokens =
        this.config.maxTokens !== undefined && accumulatedTokens + tokens > this.config.maxTokens;

      if (willExceedMessages || willExceedTokens) {
        // We cannot keep this message (and thus any older messages)
        // But wait, if we drop this message, we must ensure we don't break tool pairs.
        // Trimming logic usually drops oldest first.
        // So if we stop here, we are effectively keeping [i+1 ... end] + system.
        // We just need to validate tool integrity for the set we gathered.
        break;
      }

      recentIndices.push(i);
      accumulatedTokens += tokens;
      accumulatedMessages += 1;
    }

    // Reverse to get chronological order [oldest ... newest]
    recentIndices.reverse();
    keptIndices = keptIndices.concat(recentIndices);

    // Step 3: Validate tool integrity
    // If we kept a tool result, we must also ensure we kept its assistant call.
    // Since we scanned from end (recent), we likely kept results first.
    // If we kept a Result at index K, check if Call is at index J (where J < K).
    // If J is not in keptIndices, we must Drop K.

    // Refine keptIndices
    const keptSet = new Set(keptIndices);
    const finalIndices: number[] = [];

    // Add system first
    if (keptSet.has(0)) finalIndices.push(0);

    // Process recent messages
    for (const idx of recentIndices) {
      const msg = messages[idx];
      if (!msg) continue;

      if (msg.role === "tool" && msg.tool_call_id) {
        const assistantIdx = toolCallToAssistant.get(msg.tool_call_id);
        // If assistant not found or not in our kept set, we drop this tool result
        if (assistantIdx === undefined || !keptSet.has(assistantIdx)) {
          continue; // Drop orphan result
        }
      }
      finalIndices.push(idx);
    }

    // Step 4: Rebuild messages array
    const keptMessages = finalIndices
      .map((i) => messages[i])
      .filter((msg): msg is ChatMessage => msg !== undefined);

    if (keptMessages.length === 0) {
      // Should effectively never happen as we force 0, but safety check
      if (messages.length > 0) {
        const sysMsg = messages[0];
        if (sysMsg) {
          keptMessages.push(sysMsg);
        }
      }
    }

    // Safety check 2: if only system remains but we had more, and logic stripped everything else? valid.

    messages.length = 0;
    messages.push(...keptMessages);

    const result: TrimResult = {
      originalCount: originalLength,
      trimmedCount: messages.length,
      messagesRemoved: originalLength - messages.length,
      estimatedTokens: this.calculateTotalTokens(messages),
    };

    return logger
      .warn("Message history trimmed", {
        agentId,
        conversationId,
        limits: { maxMessages: this.config.maxMessages, maxTokens: this.config.maxTokens },
        originalCount: result.originalCount,
        trimmedCount: result.trimmedCount,
        estimatedTokens: result.estimatedTokens,
      })
      .pipe(Effect.map(() => result));
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
  // Default safer token limit (conservative for most models)
  maxTokens: 120000,
  strategy: "token-based",
});
