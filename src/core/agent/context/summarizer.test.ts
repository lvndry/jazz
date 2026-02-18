import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { Summarizer, type RecursiveRunner } from "./summarizer";
import { AgentConfigServiceTag, type AgentConfigService } from "../../interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../../interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "../../interfaces/presentation";
import type { Agent, AgentConfig, AppConfig } from "../../types";
import type { ChatMessage, ConversationMessages } from "../../types/message";
import type { AgentResponse } from "../types";

// Helper to create a mock agent
function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  const config: AgentConfig = {
    llmProvider: "openai",
    llmModel: "gpt-4",
    persona: "default",
    tools: [],
  };
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    model: "openai/gpt-4",
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Mock logger that does nothing
const mockLogger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setSessionId: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  clearSessionId: () => Effect.void,
};

// Mock AppConfig
const mockAppConfig: AppConfig = {
  storage: { type: "file", path: "/tmp/test" },
  logging: { level: "info", format: "plain" },
};

// Mock AgentConfigService
const mockAgentConfigService: AgentConfigService = {
  appConfig: Effect.succeed(mockAppConfig),
  getAgentConfig: () => Effect.succeed(createMockAgent().config),
  saveAgentConfig: () => Effect.void,
};

// Mock LLMService (minimal implementation for model selection)
const mockLLMService: LLMService = {
  getProvider: () =>
    Effect.succeed({
      name: "openai" as const,
      supportedModels: [
        { id: "gpt-4", supportsTools: true },
        { id: "gpt-4o-mini", supportsTools: true },
      ],
      defaultModel: "gpt-4",
      authenticate: () => Effect.void,
    }),
  listProviders: () => Effect.succeed([]),
  createChatCompletion: () =>
    Effect.succeed({ content: "", toolCalls: undefined, usage: undefined }),
  createStreamingChatCompletion: () => Effect.fail(new Error("Not implemented in mock")),
  supportsNativeWebSearch: () => Effect.succeed(false),
};

// Mock PresentationService (minimal implementation for tests)
const mockPresentationService: PresentationService = {
  presentThinking: () => Effect.void,
  presentCompletion: () => Effect.void,
  presentWarning: () => Effect.void,
  presentAgentResponse: () => Effect.void,
  renderMarkdown: (md) => Effect.succeed(md),
  formatToolArguments: () => "",
  formatToolResult: () => "",
  formatToolExecutionStart: () => Effect.succeed(""),
  formatToolExecutionComplete: () => Effect.succeed(""),
  formatToolExecutionError: () => Effect.succeed(""),
  formatToolsDetected: () => Effect.succeed(""),
  createStreamingRenderer: () =>
    Effect.succeed({
      handleEvent: () => Effect.void,
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    }),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  requestApproval: () => Effect.succeed({ approved: true }),
  signalToolExecutionStarted: () => Effect.void,
  requestUserInput: () => Effect.succeed(""),
  requestFilePicker: () => Effect.succeed(""),
};

// Create a mock layer for testing
function createTestLayer() {
  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    Layer.succeed(LLMServiceTag, mockLLMService),
    Layer.succeed(PresentationServiceTag, mockPresentationService),
  );
}

// Mock recursive runner that returns a summary
function createMockRecursiveRunner(mockContent: string): RecursiveRunner {
  return (_options) =>
    Effect.succeed({
      content: mockContent,
      conversationId: "test-conv-id",
    } as AgentResponse);
}

describe("Summarizer", () => {
  describe("summarizeHistory", () => {
    it("should return empty message for empty history", async () => {
      const mockRunner = createMockRecursiveRunner("This should not be called");
      const agent = createMockAgent();

      const testEffect = Summarizer.summarizeHistory([], agent, "session-1", "conv-1", mockRunner);

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      expect(result.role).toBe("assistant");
      expect(result.content).toBe("No history to summarize.");
    });

    it("should call recursive runner with history text", async () => {
      let capturedInput: string | undefined;
      const mockRunner: RecursiveRunner = (options) => {
        capturedInput = options.userInput;
        return Effect.succeed({
          content: "Summary of conversation",
          conversationId: "test-conv",
        } as AgentResponse);
      };

      const agent = createMockAgent();
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];

      const testEffect = Summarizer.summarizeHistory(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      expect(result.role).toBe("assistant");
      expect(result.content).toBe("Summary of conversation");
      expect(capturedInput).toContain("[USER] Hello");
      expect(capturedInput).toContain("[ASSISTANT] Hi there!");
    });

    it("should include tool calls in history text", async () => {
      let capturedInput: string | undefined;
      const mockRunner: RecursiveRunner = (options) => {
        capturedInput = options.userInput;
        return Effect.succeed({
          content: "Summary",
          conversationId: "test-conv",
        } as AgentResponse);
      };

      const agent = createMockAgent();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Let me check that file.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"/test.txt"}' },
            },
          ],
        },
      ];

      const testEffect = Summarizer.summarizeHistory(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      expect(capturedInput).toContain("[Tool Calls: read_file]");
    });

    it("should create summarizer agent with correct config", async () => {
      let capturedAgent: Agent | undefined;
      const mockRunner: RecursiveRunner = (options) => {
        capturedAgent = options.agent;
        return Effect.succeed({
          content: "Summary",
          conversationId: "test-conv",
        } as AgentResponse);
      };

      const agent = createMockAgent({ id: "my-agent", name: "My Agent" });
      const messages: ChatMessage[] = [{ role: "user", content: "Test" }];

      const testEffect = Summarizer.summarizeHistory(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      expect(capturedAgent?.id).toBe("summarizer");
      expect(capturedAgent?.name).toBe("Summarizer");
      expect(capturedAgent?.config.persona).toBe("summarizer");
    });

    it("should use max iterations of 1 for summarizer", async () => {
      let capturedMaxIterations: number | undefined;
      const mockRunner: RecursiveRunner = (options) => {
        capturedMaxIterations = options.maxIterations;
        return Effect.succeed({
          content: "Summary",
          conversationId: "test-conv",
        } as AgentResponse);
      };

      const agent = createMockAgent();
      const messages: ChatMessage[] = [{ role: "user", content: "Test" }];

      const testEffect = Summarizer.summarizeHistory(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      expect(capturedMaxIterations).toBe(1);
    });

    it("should format messages with separators", async () => {
      let capturedInput: string | undefined;
      const mockRunner: RecursiveRunner = (options) => {
        capturedInput = options.userInput;
        return Effect.succeed({
          content: "Summary",
          conversationId: "test-conv",
        } as AgentResponse);
      };

      const agent = createMockAgent();
      const messages: ChatMessage[] = [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Second message" },
        { role: "user", content: "Third message" },
      ];

      const testEffect = Summarizer.summarizeHistory(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ChatMessage,
          Error,
          never
        >,
      );

      // Messages should be separated by "---"
      expect(capturedInput).toContain("---");
      // Check the separator pattern
      const separatorCount = (capturedInput?.match(/---/g) || []).length;
      expect(separatorCount).toBe(2); // 3 messages = 2 separators
    });
  });

  describe("splitMessages", () => {
    it("should preserve the system message", () => {
      const messages: ConversationMessages = [
        { role: "system", content: "You are an assistant" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "Good!" },
      ];

      const result = Summarizer.splitMessages(messages, 2000);

      expect(result.systemMessage.content).toBe("You are an assistant");
    });

    it("should split older messages from recent ones", () => {
      // Create enough messages with enough content that the 20% recent budget
      // can't absorb them all, so some older messages are left to summarize.
      const messages: ConversationMessages = [
        { role: "system", content: "You are an assistant" },
        ...Array.from({ length: 20 }, (_, i) => [
          { role: "user" as const, content: `User message ${i + 1}: ${"x".repeat(100)}` },
          {
            role: "assistant" as const,
            content: `Assistant response ${i + 1}: ${"y".repeat(100)}`,
          },
        ]).flat(),
      ];

      const result = Summarizer.splitMessages(messages, 2000);

      // Should have some messages to summarize
      expect(result.messagesToSummarize.length).toBeGreaterThan(0);
      // Should have some recent messages kept
      expect(result.sanitizedRecentMessages.length).toBeGreaterThan(0);
      // Total should account for all non-system messages
      expect(result.messagesToSummarize.length + result.sanitizedRecentMessages.length).toBe(
        messages.length - 1,
      );
    });

    it("should return empty messagesToSummarize when all messages fit in recent budget", () => {
      // Very few tiny messages with a large context window — everything fits in recent
      const messages: ConversationMessages = [
        { role: "system", content: "You are an assistant" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ];

      const result = Summarizer.splitMessages(messages, 200_000);

      // All non-system messages fit in recent budget, nothing to summarize
      expect(result.messagesToSummarize.length).toBe(0);
      expect(result.sanitizedRecentMessages.length).toBe(2);
    });

    it("should sanitize orphaned tool call references in recent messages", () => {
      const messages: ConversationMessages = [
        { role: "system", content: "You are an assistant" },
        // These will be in the "to summarize" portion (older)
        {
          role: "assistant",
          content: "Let me check that.",
          tool_calls: [
            {
              id: "tc-old",
              type: "function" as const,
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tc-old", content: "file contents" },
        // Pad with enough messages to push the above into the summarize portion
        ...Array.from({ length: 16 }, (_, i) => [
          { role: "user" as const, content: `Message ${i}: ${"z".repeat(100)}` },
          { role: "assistant" as const, content: `Response ${i}: ${"w".repeat(100)}` },
        ]).flat(),
        // This tool result references tc-old which will be in the summarized portion
        { role: "tool", tool_call_id: "tc-old", content: "orphaned result" },
      ];

      const result = Summarizer.splitMessages(messages, 2000);

      // The orphaned tool result (referencing tc-old) should be dropped from recent
      const orphanedToolResults = result.sanitizedRecentMessages.filter(
        (m) => m.role === "tool" && m.tool_call_id === "tc-old",
      );
      expect(orphanedToolResults.length).toBe(0);
    });
  });

  describe("compactIfNeeded", () => {
    it("should return original messages when under threshold", async () => {
      const mockRunner = createMockRecursiveRunner("This should not be called");
      const agent = createMockAgent();

      // Small message list that won't trigger compaction
      const messages: ConversationMessages = [
        { role: "system", content: "You are an assistant" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ];

      const testEffect = Summarizer.compactIfNeeded(
        messages,
        agent,
        "session-1",
        "conv-1",
        mockRunner,
      );

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
          ConversationMessages,
          Error,
          never
        >,
      );

      // Should return the same array since it's under threshold
      expect(result.length).toBe(3);
      expect(result[0]?.content).toBe("You are an assistant");
    });
  });
});
