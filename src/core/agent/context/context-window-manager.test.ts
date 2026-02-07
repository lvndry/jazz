import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { ContextWindowManager } from "./context-window-manager";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { LoggerServiceTag } from "../../interfaces/logger";
import type { ChatMessage, ConversationMessages } from "../../types/message";

const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setSessionId: () => Effect.void,
  clearSessionId: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
} as any;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as any;

const TestLayer = Layer.mergeAll(
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
);

function makeMessage(role: string, content: string, extra?: Record<string, unknown>): ChatMessage {
  return { role, content, ...extra } as ChatMessage;
}

describe("ContextWindowManager", () => {
  describe("calculateTotalTokens", () => {
    it("should estimate tokens based on content length", () => {
      const manager = new ContextWindowManager({ maxMessages: 100 });
      // ~4 chars per token + 4 overhead per message
      const messages = [makeMessage("user", "Hello world")]; // 11 chars = ~3 tokens + 4 overhead = 7
      const tokens = manager.calculateTotalTokens(messages);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it("should include tool call tokens in estimate", () => {
      const manager = new ContextWindowManager({ maxMessages: 100 });
      const withoutTools = [makeMessage("assistant", "content")];
      const withTools = [
        makeMessage("assistant", "content", {
          tool_calls: [{ id: "1", type: "function", function: { name: "test", arguments: '{"key":"value"}' } }],
        }),
      ];
      const tokensWithout = manager.calculateTotalTokens(withoutTools);
      const tokensWith = manager.calculateTotalTokens(withTools);
      expect(tokensWith).toBeGreaterThan(tokensWithout);
    });
  });

  describe("needsTrimming", () => {
    it("should return true when message count exceeds limit", () => {
      const manager = new ContextWindowManager({ maxMessages: 3 });
      const messages = [
        makeMessage("system", "sys"),
        makeMessage("user", "1"),
        makeMessage("assistant", "2"),
        makeMessage("user", "3"),
      ];
      expect(manager.needsTrimming(messages)).toBe(true);
    });

    it("should return false when within limits", () => {
      const manager = new ContextWindowManager({ maxMessages: 10 });
      const messages = [makeMessage("user", "Hello")];
      expect(manager.needsTrimming(messages)).toBe(false);
    });

    it("should return true when token count exceeds limit", () => {
      const manager = new ContextWindowManager({ maxMessages: 1000, maxTokens: 10 });
      // Create messages with enough content to exceed 10 tokens
      const messages = [
        makeMessage("user", "This is a very long message that should exceed the token limit for testing"),
      ];
      expect(manager.needsTrimming(messages)).toBe(true);
    });
  });

  describe("shouldSummarize", () => {
    it("should return false when no maxTokens is set", () => {
      const manager = new ContextWindowManager({ maxMessages: 100 });
      const messages = [makeMessage("user", "test")];
      expect(manager.shouldSummarize(messages)).toBe(false);
    });

    it("should return true when tokens exceed 80% threshold", () => {
      const manager = new ContextWindowManager({ maxMessages: 1000, maxTokens: 20 });
      // Create enough content to exceed 80% of 20 = 16 tokens
      const messages = [
        makeMessage("user", "This is a test message with enough content to exceed the threshold for summarization"),
      ];
      expect(manager.shouldSummarize(messages)).toBe(true);
    });

    it("should return false when well below threshold", () => {
      const manager = new ContextWindowManager({ maxMessages: 1000, maxTokens: 100_000 });
      const messages = [makeMessage("user", "short")];
      expect(manager.shouldSummarize(messages)).toBe(false);
    });
  });

  describe("trim", () => {
    it("should not trim when within limits", async () => {
      const manager = new ContextWindowManager({ maxMessages: 100 });
      const messages: ConversationMessages = [
        makeMessage("system", "sys"),
        makeMessage("user", "hello"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.result).toBeUndefined();
    });

    it("should trim when message count exceeds limit", async () => {
      const manager = new ContextWindowManager({
        maxMessages: 4,
        protectedRecentMessages: 2,
      });
      const messages: ConversationMessages = [
        makeMessage("system", "sys"),
        makeMessage("user", "old1"),
        makeMessage("assistant", "old2"),
        makeMessage("user", "old3"),
        makeMessage("assistant", "old4"),
        makeMessage("user", "recent1"),
        makeMessage("assistant", "recent2"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      expect(result.messages.length).toBeLessThanOrEqual(4);
      expect(result.result).toBeDefined();
      expect(result.result!.messagesRemoved).toBeGreaterThan(0);
      // System message should always be preserved
      expect(result.messages[0].role).toBe("system");
    });

    it("should preserve tool call/result pairs", async () => {
      const manager = new ContextWindowManager({
        maxMessages: 5,
        protectedRecentMessages: 2,
      });
      const messages: ConversationMessages = [
        makeMessage("system", "sys"),
        makeMessage("user", "old"),
        makeMessage("assistant", "calling tool", {
          tool_calls: [{ id: "tc1", type: "function", function: { name: "test", arguments: "{}" } }],
        }),
        makeMessage("tool", "result", { tool_call_id: "tc1", name: "test" }),
        makeMessage("user", "recent1"),
        makeMessage("assistant", "recent2"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      // If the assistant with tool_calls is kept, the corresponding tool result should also be kept
      const hasToolCall = result.messages.some(
        (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
      );
      const hasToolResult = result.messages.some(
        (m) => m.role === "tool" && (m as any).tool_call_id === "tc1",
      );

      if (hasToolCall) {
        expect(hasToolResult).toBe(true);
      }
    });

    it("should always preserve system message", async () => {
      const manager = new ContextWindowManager({
        maxMessages: 2,
        protectedRecentMessages: 1,
      });
      const messages: ConversationMessages = [
        makeMessage("system", "important system prompt"),
        makeMessage("user", "1"),
        makeMessage("assistant", "2"),
        makeMessage("user", "3"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      expect(result.messages[0].content).toBe("important system prompt");
      expect(result.messages[0].role).toBe("system");
    });
  });

  describe("getConfig", () => {
    it("should return a copy of the configuration", () => {
      const config = { maxMessages: 50, maxTokens: 10000, strategy: "token-based" as const };
      const manager = new ContextWindowManager(config);
      const retrieved = manager.getConfig();
      expect(retrieved.maxMessages).toBe(50);
      expect(retrieved.maxTokens).toBe(10000);
    });
  });
});
