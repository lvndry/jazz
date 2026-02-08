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
      const manager = new ContextWindowManager({ maxTokens: 100_000 });
      // ~4 chars per token + 4 overhead per message
      const messages = [makeMessage("user", "Hello world")]; // 11 chars = ~3 tokens + 4 overhead = 7
      const tokens = manager.calculateTotalTokens(messages);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it("should include tool call tokens in estimate", () => {
      const manager = new ContextWindowManager({ maxTokens: 100_000 });
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
    it("should return true when token count exceeds limit", () => {
      const manager = new ContextWindowManager({ maxTokens: 10 });
      // Create messages with enough content to exceed 10 tokens
      const messages = [
        makeMessage("user", "This is a very long message that should exceed the token limit for testing"),
      ];
      expect(manager.needsTrimming(messages)).toBe(true);
    });

    it("should return false when within limits", () => {
      const manager = new ContextWindowManager({ maxTokens: 100_000 });
      const messages = [makeMessage("user", "Hello")];
      expect(manager.needsTrimming(messages)).toBe(false);
    });
  });

  describe("shouldSummarize", () => {
    it("should return true when tokens exceed 80% threshold", () => {
      const manager = new ContextWindowManager({ maxTokens: 20 });
      // Create enough content to exceed 80% of 20 = 16 tokens
      const messages = [
        makeMessage("user", "This is a test message with enough content to exceed the threshold for summarization"),
      ];
      expect(manager.shouldSummarize(messages)).toBe(true);
    });

    it("should return false when well below threshold", () => {
      const manager = new ContextWindowManager({ maxTokens: 100_000 });
      const messages = [makeMessage("user", "short")];
      expect(manager.shouldSummarize(messages)).toBe(false);
    });
  });

  describe("trim", () => {
    it("should not trim when within limits", async () => {
      const manager = new ContextWindowManager({ maxTokens: 100_000 });
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

    it("should trim when token count exceeds limit", async () => {
      const manager = new ContextWindowManager({
        maxTokens: 30,
        protectedRecentTurns: 1,
      });
      const messages: ConversationMessages = [
        makeMessage("system", "sys"),
        makeMessage("user", "old message one"),
        makeMessage("assistant", "old message two"),
        makeMessage("user", "old message three"),
        makeMessage("assistant", "old message four"),
        makeMessage("user", "recent1"),
        makeMessage("assistant", "recent2"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      expect(result.messages.length).toBeLessThan(messages.length);
      expect(result.result).toBeDefined();
      expect(result.result!.messagesRemoved).toBeGreaterThan(0);
      // System message should always be preserved
      expect(result.messages[0].role).toBe("system");
    });

    it("should protect entire turns including tool calls", async () => {
      // With protectedRecentTurns: 1, the last turn (user + assistant with tools + tool results)
      // should all be protected, regardless of how many tool messages there are
      const manager = new ContextWindowManager({
        maxTokens: 40,
        protectedRecentTurns: 1,
      });
      const messages: ConversationMessages = [
        makeMessage("system", "sys"),
        makeMessage("user", "old question"),
        makeMessage("assistant", "old answer"),
        // Last turn: user + assistant with 3 tool calls + 3 tool results + final assistant
        makeMessage("user", "do stuff"),
        makeMessage("assistant", "calling tools", {
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
            { id: "tc2", type: "function", function: { name: "write", arguments: "{}" } },
            { id: "tc3", type: "function", function: { name: "exec", arguments: "{}" } },
          ],
        }),
        makeMessage("tool", "r1", { tool_call_id: "tc1", name: "read" }),
        makeMessage("tool", "r2", { tool_call_id: "tc2", name: "write" }),
        makeMessage("tool", "r3", { tool_call_id: "tc3", name: "exec" }),
        makeMessage("assistant", "done"),
      ] as ConversationMessages;

      const result = await Effect.runPromise(
        manager.trim(messages, mockLogger, "agent-1", "conv-1").pipe(Effect.provide(TestLayer)),
      );

      // The last turn's user message must be present
      expect(result.messages.some((m) => m.content === "do stuff")).toBe(true);
      // All 3 tool results must be present (they're in the protected turn)
      expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(3);
      // The final assistant response must be present
      expect(result.messages.some((m) => m.content === "done")).toBe(true);
    });

    it("should preserve tool call/result pairs in non-protected zone", async () => {
      const manager = new ContextWindowManager({
        maxTokens: 80,
        protectedRecentTurns: 1,
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
        maxTokens: 20,
        protectedRecentTurns: 1,
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
      const config = { maxTokens: 10000 };
      const manager = new ContextWindowManager(config);
      const retrieved = manager.getConfig();
      expect(retrieved.maxTokens).toBe(10000);
    });
  });
});
