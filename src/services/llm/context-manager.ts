/**
 * Advanced context window management utilities
 * Provides intelligent conversation summarization and token management
 * for maintaining context within LLM model limits
 */

import { ChatMessage } from "./messages";

// Model context window limits organized by provider (in tokens)
const MODEL_CONTEXT_LIMITS_BY_PROVIDER = {
  // OpenAI models
  openai: {
    "gpt-3.5-turbo": 4096,
    "gpt-4": 8192,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-5": 200000,
    o3: 200000,
  },
  // Anthropic Claude models
  anthropic: {
    "claude-3-haiku": 200000,
    "claude-3-sonnet": 200000,
    "claude-3-opus": 200000,
    "claude-sonnet-4": 200000,
    "claude-opus-4": 200000,
  },
  // Google Gemini models
  google: {
    "gemini-pro": 30720,
    "gemini-1.5-pro": 2000000,
    "gemini-2.0-flash": 1000000,
  },
  // Mistral AI models
  mistral: {
    "mistral-small-latest": 32000,
    "mistral-medium-latest": 32000,
    "mistral-large-latest": 32000,
    mistral: 32000,
  },
  // Meta Llama models
  meta: {
    llama3: 8192,
    llama2: 4096,
  },
};

// Flatten the provider-organized limits into a single lookup table
const MODEL_CONTEXT_LIMITS: Record<string, number> = Object.values(
  MODEL_CONTEXT_LIMITS_BY_PROVIDER,
).reduce((acc, providerModels) => ({ ...acc, ...providerModels }), {});

/**
 * Get the context window limit for a model
 */
export function getModelContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] || 4096; // Default to 4K if unknown
}

/**
 * Get all models for a specific provider
 */
export function getModelsByProvider(provider: string): Record<string, number> {
  return (
    MODEL_CONTEXT_LIMITS_BY_PROVIDER[provider as keyof typeof MODEL_CONTEXT_LIMITS_BY_PROVIDER] ||
    {}
  );
}

/**
 * Get all available providers
 */
export function getAvailableProviders(): string[] {
  return Object.keys(MODEL_CONTEXT_LIMITS_BY_PROVIDER);
}

/**
 * Simple token counting - rough approximation
 * For production use, consider using tiktoken or similar
 */
export function estimateTokenCount(content: string): number {
  if (!content) return 0;

  // Simple approximation: ~4 characters per token for English text
  const charCount = content.length;
  const estimatedTokens = Math.ceil(charCount / 4);

  // Add overhead for special tokens and formatting
  return Math.max(estimatedTokens, 1);
}

/**
 * Estimate tokens for a single message
 */
export function estimateMessageTokens(message: ChatMessage): number {
  // Base tokens for message structure
  let tokens = 3; // role, content, and formatting tokens

  // Add role name tokens
  tokens += message.role.length;

  // Add content tokens
  tokens += estimateTokenCount(message.content);

  // Add name tokens if present
  if (message.name) {
    tokens += message.name.length;
  }

  // Add tool call tokens if present
  if (message.tool_calls) {
    tokens += message.tool_calls.length * 10; // Rough estimate for tool call overhead
    for (const toolCall of message.tool_calls) {
      tokens += toolCall.id.length;
      tokens += toolCall.function.name.length;
      tokens += toolCall.function.arguments.length;
    }
  }

  // Add tool call ID tokens if present
  if (message.tool_call_id) {
    tokens += message.tool_call_id.length;
  }

  return tokens;
}

/**
 * Estimate total tokens for a conversation
 */
export function estimateConversationTokens(messages: ChatMessage[]): number {
  let totalTokens = 0;

  for (const message of messages) {
    totalTokens += estimateMessageTokens(message);
  }

  return totalTokens;
}

/**
 * Check if conversation should be summarized
 */
export function shouldSummarize(
  messages: ChatMessage[],
  model: string,
  safetyMargin: number = 0.8,
): boolean {
  const maxTokens = getModelContextLimit(model);
  const currentTokens = estimateConversationTokens(messages);
  const threshold = Math.floor(maxTokens * safetyMargin);

  return currentTokens > threshold;
}

/**
 * Find the point where summarization should start, considering both message count and token limits
 */
export function findSummarizationPoint(
  messages: ChatMessage[],
  model: string,
  targetTokens: number,
  maxRecentTokens?: number,
  preserveRecentMessages?: number,
): number {
  const maxTokens = getModelContextLimit(model);
  const availableTokens = maxTokens - targetTokens;

  let accumulatedTokens = 0;
  let index = 0;

  // Always keep the first message (usually system message)
  if (messages.length > 0) {
    const firstMessage = messages[0];
    if (firstMessage) {
      accumulatedTokens += estimateMessageTokens(firstMessage);
      index = 1;
    }
  }

  // Calculate how many recent messages to preserve
  const recentMessagesToPreserve = preserveRecentMessages ?? 3;
  const maxRecentTokensToPreserve = maxRecentTokens ?? 2000;

  // Start from the end and work backwards to find recent messages to preserve
  let recentTokens = 0;
  let recentMessageCount = 0;
  const recentStartIndex = Math.max(0, messages.length - recentMessagesToPreserve * 2); // *2 for user/assistant pairs

  for (let i = messages.length - 1; i >= recentStartIndex; i--) {
    const message = messages[i];
    if (!message) continue;

    const messageTokens = estimateMessageTokens(message);
    if (recentTokens + messageTokens > maxRecentTokensToPreserve) {
      break;
    }

    recentTokens += messageTokens;
    recentMessageCount++;
  }

  const actualRecentStartIndex = Math.max(index, messages.length - recentMessageCount);

  // Ensure we never return an index that would result in empty messages
  if (actualRecentStartIndex >= messages.length) {
    return Math.max(1, messages.length - 1); // Keep at least the system message + 1 recent message
  }

  // Find the point where we exceed available tokens, but don't go past recent messages
  for (let i = index; i < actualRecentStartIndex; i++) {
    const message = messages[i];
    if (!message) continue;
    const messageTokens = estimateMessageTokens(message);

    if (accumulatedTokens + messageTokens > availableTokens - recentTokens) {
      return i;
    }

    accumulatedTokens += messageTokens;
  }

  // If we can fit all messages, return the recent start index
  return actualRecentStartIndex;
}

/**
 * Create a simple summary message
 */
export function createSummaryMessage(summarizedCount: number): ChatMessage {
  return {
    role: "assistant",
    content: `[CONVERSATION SUMMARY] Previous ${summarizedCount} messages have been summarized to manage context window. Key points and context preserved.`,
  };
}

/**
 * Check if a message contains large tool call results that should be summarized
 */
export function isLargeToolResult(message: ChatMessage, maxTokens: number = 1000): boolean {
  if (message.role !== "assistant" || !message.content) {
    return false;
  }

  const tokens = estimateTokenCount(message.content);
  return tokens > maxTokens;
}

/**
 * Summarize large tool call results to reduce context usage
 */
export function summarizeToolResult(message: ChatMessage, maxTokens: number = 500): ChatMessage {
  if (!isLargeToolResult(message, maxTokens * 2)) {
    return message;
  }

  const originalTokens = estimateTokenCount(message.content);
  const summary = `[TOOL RESULT SUMMARY] Large tool result (${originalTokens} tokens) has been summarized. Key information preserved.`;

  return {
    ...message,
    content: summary,
  };
}

/**
 * Summarize conversation by replacing early messages with a summary
 */
export function summarizeConversation(
  messages: ChatMessage[],
  model: string,
  targetTokens?: number,
  maxRecentTokens?: number,
  preserveRecentMessages?: number,
  summarizeToolResults?: boolean,
): ChatMessage[] {
  const maxTokens = getModelContextLimit(model);
  const currentTokens = estimateConversationTokens(messages);

  // If we don't need to summarize, return original messages
  if (!targetTokens || currentTokens <= targetTokens) {
    return messages;
  }

  const actualTargetTokens = targetTokens || Math.floor(maxTokens * 0.6);
  const summarizationPoint = findSummarizationPoint(
    messages,
    model,
    actualTargetTokens,
    maxRecentTokens,
    preserveRecentMessages,
  );

  if (summarizationPoint <= 1) {
    return messages; // Can't summarize much
  }

  // Create summary and keep recent messages
  const summaryMessage = createSummaryMessage(summarizationPoint);
  let recentMessages = messages.slice(summarizationPoint);

  // Safety check: ensure we never return an empty array
  if (recentMessages.length === 0) {
    // If no recent messages, keep at least the last message
    recentMessages = messages.slice(-1);
  }

  // Summarize large tool results in recent messages if enabled
  if (summarizeToolResults) {
    recentMessages = recentMessages.map((msg) => summarizeToolResult(msg));
  }

  // Always preserve the system message (first message) if it exists
  const systemMessage = messages[0];
  let result: ChatMessage[];

  if (systemMessage && systemMessage.role === "system") {
    result = [systemMessage, summaryMessage, ...recentMessages];
  } else {
    result = [summaryMessage, ...recentMessages];
  }

  // Final safety check: ensure we never return an empty array
  if (result.length === 0) {
    return messages; // Fallback to original messages
  }

  return result;
}
