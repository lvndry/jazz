import { describe, expect, it } from "bun:test";
import {
  estimateConversationTokens,
  getModelContextLimit,
  shouldSummarize,
  summarizeConversation,
} from "../../services/llm/context-manager";
import type { ChatMessage } from "../../services/llm/messages";

describe("Context Management", () => {
  const createTestMessages = (count: number): ChatMessage[] => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a helpful assistant designed to help users with various tasks including coding, writing, analysis, and problem-solving. You should provide detailed, accurate, and helpful responses while maintaining a professional and friendly tone.",
      },
    ];

    for (let i = 0; i < count; i++) {
      messages.push(
        {
          role: "user",
          content: `User message ${i + 1}: This is a comprehensive test message designed to simulate realistic user input. It contains multiple sentences, technical terminology, and detailed explanations to ensure proper token counting. The message includes various programming concepts, business requirements, and complex scenarios that would typically be encountered in real-world conversations with AI assistants. This helps us test the context management system under realistic conditions.`,
        },
        {
          role: "assistant",
          content: `Assistant response ${i + 1}: I understand your request completely. This is a detailed and comprehensive response that addresses your question thoroughly. I'll provide you with step-by-step guidance, code examples where applicable, and best practices to help you achieve your goals. The response includes multiple sections covering different aspects of your request, ensuring you have all the information needed to proceed successfully. I'll also include relevant considerations, potential challenges, and alternative approaches to give you a complete picture.`,
        },
      );
    }

    return messages;
  };

  it("should correctly estimate token counts", () => {
    const messages = createTestMessages(5);
    const tokens = estimateConversationTokens(messages);

    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10000); // Reasonable upper bound
  });

  it("should determine when summarization is needed", () => {
    const shortMessages = createTestMessages(3);
    const longMessages = createTestMessages(50); // Much longer conversation

    // Use smaller model for testing to make summarization thresholds more realistic

    // Short conversation should not need summarization
    expect(shouldSummarize(shortMessages, "gpt-3.5-turbo", 0.8)).toBe(false);

    // Long conversation should need summarization
    expect(shouldSummarize(longMessages, "gpt-3.5-turbo", 0.8)).toBe(true);
  });

  it("should summarize conversations when needed", () => {
    const longMessages = createTestMessages(15);
    const originalTokens = estimateConversationTokens(longMessages);

    const summarized = summarizeConversation(longMessages, "gpt-4o", 1000);
    const summarizedTokens = estimateConversationTokens(summarized);

    expect(summarized.length).toBeLessThan(longMessages.length);
    expect(summarizedTokens).toBeLessThan(originalTokens);
    expect(summarizedTokens).toBeLessThanOrEqual(1000);

    // Should preserve system message
    expect(summarized[0]?.role).toBe("system");

    // Should have a summary message
    const hasSummary = summarized.some(
      (msg) => msg.role === "assistant" && msg.content.includes("CONVERSATION SUMMARY"),
    );
    expect(hasSummary).toBe(true);
  });

  it("should handle different model context limits", () => {
    expect(getModelContextLimit("gpt-4o")).toBe(128000);
    expect(getModelContextLimit("gpt-3.5-turbo")).toBe(4096);
    expect(getModelContextLimit("claude-3-sonnet")).toBe(200000);
    expect(getModelContextLimit("unknown-model")).toBe(4096); // Default
  });

  it("should not summarize when not needed", () => {
    const shortMessages = createTestMessages(2);
    const result = summarizeConversation(shortMessages, "gpt-4o", 10000);

    // Should return original messages unchanged
    expect(result).toEqual(shortMessages);
  });

  it("should preserve recent messages in summarization", () => {
    const messages = createTestMessages(20);

    const summarized = summarizeConversation(messages, "gpt-3.5-turbo", 1000);

    // Should preserve some recent messages
    expect(summarized.length).toBeGreaterThan(2); // At least system + summary + some recent
    expect(summarized[summarized.length - 1]?.content).toContain("Assistant response 20");
  });

  it("should never return empty message arrays", () => {
    const messages = createTestMessages(5);

    // Test with very restrictive token limits that could cause empty arrays
    const summarized = summarizeConversation(messages, "gpt-3.5-turbo", 50);

    // Should never return empty array
    expect(summarized.length).toBeGreaterThan(0);

    // Should always have at least the system message
    expect(summarized[0]?.role).toBe("system");
  });
});
