import { Effect } from "effect";
import type { AgentConfigService } from "../interfaces/agent-config";
import type { LoggerService } from "../interfaces/logger";
import type { ChatMessage } from "../types/message";

/**
 * Configuration for context window management
 */
export interface ContextWindowConfig {
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
}

/**
 * Manages conversation context window to prevent unbounded growth
 * while preserving message integrity (tool calls, system prompts, etc.)
 */
export class ContextWindowManager {
  constructor(private readonly config: ContextWindowConfig) {}

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
    if (messages.length <= this.config.maxMessages) {
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

    // Step 2: Determine which messages to keep
    const startIndex = Math.max(1, messages.length - (this.config.maxMessages - 1));

    // Step 3: Validate and adjust the trim boundary
    // Scan from startIndex to find any orphaned tool results
    const indicesToKeep = new Set<number>();
    indicesToKeep.add(0); // Always keep system message

    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      if (msg.role === "tool" && msg.tool_call_id) {
        // This is a tool result - check if its assistant message is kept
        const assistantIndex = toolCallToAssistant.get(msg.tool_call_id);

        if (assistantIndex !== undefined && assistantIndex >= startIndex) {
          // Assistant message is kept, so keep this tool result
          indicesToKeep.add(i);
          indicesToKeep.add(assistantIndex);
        }
        // If assistant was trimmed, skip this tool result to prevent orphaned results
      } else {
        // Keep all non-tool messages in the range
        indicesToKeep.add(i);
      }
    }

    // Step 4: Rebuild messages array
    const keptMessages = Array.from(indicesToKeep)
      .sort((a, b) => a - b)
      .map((i) => messages[i])
      .filter((msg): msg is ChatMessage => msg !== undefined);

    if (keptMessages.length === 0) {
      throw new Error(
        `Context window trim resulted in empty messages array. System message should always be preserved. Original count: ${originalLength}`,
      );
    }

    messages.length = 0;
    messages.push(...keptMessages);

    const result: TrimResult = {
      originalCount: originalLength,
      trimmedCount: messages.length,
      messagesRemoved: originalLength - messages.length,
    };

    return logger
      .warn("Message history trimmed to prevent memory issues", {
        agentId,
        conversationId,
        maxMessages: this.config.maxMessages,
        originalCount: result.originalCount,
        trimmedCount: result.trimmedCount,
      })
      .pipe(Effect.map(() => result));
  }

  /**
   * Check if messages need trimming
   */
  needsTrimming(messages: ChatMessage[]): boolean {
    return messages.length > this.config.maxMessages;
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
  strategy: "recent",
});
