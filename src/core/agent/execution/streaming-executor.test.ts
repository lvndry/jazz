import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { CalendarServiceTag } from "@/core/interfaces/calendar";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { GmailServiceTag } from "@/core/interfaces/gmail";
import { LLMServiceTag } from "@/core/interfaces/llm";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { MCPServerManagerTag } from "@/core/interfaces/mcp-server";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { RecursiveRunner } from "../context/summarizer";
import {
  AgentRunContext,
  AgentRunnerOptions,
} from "../types";
import { executeWithStreaming } from "./streaming-executor";
import { ToolExecutor } from "./tool-executor";

// Mocks
const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setSessionId: () => Effect.void,
  clearSessionId: () => Effect.void,
} as any;

const mockPresentationService = {
  createStreamingRenderer: () => Effect.succeed({
    renderEvent: () => Effect.void,
    stop: () => Effect.void,
    handleEvent: () => Effect.void,
  }),
  presentThinking: () => Effect.void,
  presentThinkingEnd: () => Effect.void,
  formatToolsDetected: () => Effect.succeed("Tools detected"),
  writeOutput: () => Effect.void,
  presentCompletion: () => Effect.void,
  writeBlankLine: () => Effect.void,
  formatToolExecutionStart: () => Effect.succeed("Starting tool"),
  formatToolExecutionComplete: () => Effect.succeed("Tool completed"),
  formatToolResult: () => "Tool result",
  formatToolExecutionError: () => Effect.succeed("Tool failed"),
} as any;

const mockToolRegistry = {
  getTool: () => Effect.succeed({ approvalExecuteToolName: undefined }),
} as any;

const mockMCPServerManager = {
} as any;

const mockAgentConfigService = {
} as any;

const mockFileSystem = {} as any;
const mockTerminalService = {} as any;
const mockGmailService = {} as any;
const mockCalendarService = {} as any;
const mockFileSystemContext = {} as any;

describe("executeWithStreaming", () => {
  it("should execute a simple run with mocked services", async () => {
    // Setup Context
    const options: AgentRunnerOptions = {
        sessionId: "test-session",
        agent: {
            id: "agent-1",
            name: "test-agent",
            config: {
                model: "gpt-4",
                provider: "openai",
                reasoningEffort: "medium",
                systemPrompt: "system",
            },
            prompts: { system: "system prompt" },
        } as any,
        userInput: "hello",
    };

    const runContext: AgentRunContext = {
        actualConversationId: "conv-123",
        context: {
            agentId: "agent-1",
            workingDirectory: "/tmp",
            variables: {},
        },
        tools: [],
        messages: [{ role: "user", content: "hello" }],
        runMetrics: {
            startedAt: new Date(),
            toolCalls: [],
            toolCallCounts: {},
            toolsUsed: new Set(),
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            iterationSummaries: [],
            errors: [],
            metrics: {
                totalDuration: 0,
                totalLLMDuration: 0,
                totalToolDuration: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalCost: 0,
            },
        } as any,
        provider: "openai",
        model: "gpt-4",
        agent: options.agent,
        expandedToolNames: [],
        connectedMCPServers: [],
    };

    const displayConfig = {
        showThinking: false,
        showToolExecution: false,
        mode: "markdown" as const,
    };
    const streamingConfig = { enabled: true };
    const showMetrics = false;
    const runRecursive: RecursiveRunner = () => Effect.succeed({ content: "recursive", conversationId: "id" } as any);

    const mockLLMService = {
      createStreamingChatCompletion: () => Effect.succeed({
        stream: Stream.fromIterable([
          {
            type: "content",
            content: "Hello world",
          },
          {
            type: "complete",
            response: {
              content: "Hello world",
              toolCalls: [],
              raw: {},
            },
            metrics: { firstTokenLatencyMs: 10 },
          },
        ]),
        cancel: Effect.void,
      }),
    } as any;

    // Create Layers
    const TestLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, mockPresentationService),
        Layer.succeed(LLMServiceTag, mockLLMService),
        Layer.succeed(ToolRegistryTag, mockToolRegistry),
        Layer.succeed(MCPServerManagerTag, mockMCPServerManager),
        Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
        Layer.succeed(FileSystem.FileSystem, mockFileSystem),
        Layer.succeed(TerminalServiceTag, mockTerminalService),
        Layer.succeed(GmailServiceTag, mockGmailService),
        Layer.succeed(CalendarServiceTag, mockCalendarService),
        Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext)
    );

    // Run Effect
    const program = executeWithStreaming(
        options,
        runContext,
        displayConfig,
        streamingConfig,
        showMetrics,
        runRecursive
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));

    expect(result.content).toBe("Hello world");
    expect(result.conversationId).toBe("conv-123");
  });

  it("should execute with tool calls", async () => {
      // Mock LLM returning a tool call first, then content
      let iteration = 0;
      const mockLLMServiceWithTools = {
        createStreamingChatCompletion: (_1: any, _2: any) => {
            iteration++;
            if (iteration === 1) {
                // First call: return tool call
                return Effect.succeed({
                    stream: Stream.fromIterable([
                        {
                            type: "tool_call",
                            toolCall: {
                                id: "call_1",
                                name: "test_tool",
                                arguments: "{}",
                                function: { name: "test_tool", arguments: "{}" }
                            },
                        },
                        {
                            type: "complete",
                            response: {
                                content: "",
                                toolCalls: [{
                                    id: "call_1",
                                    name: "test_tool",
                                    arguments: "{}",
                                    function: { name: "test_tool", arguments: "{}" }
                                }],
                            },
                        }
                    ]),
                    cancel: Effect.void,
                });
            } else {
                // Second call: return result
                return Effect.succeed({
                    stream: Stream.fromIterable([
                        {
                            type: "content",
                            content: "Tool executed",
                        },
                        {
                            type: "complete",
                            response: {
                                content: "Tool executed",
                                toolCalls: [],
                            },
                        }
                    ]),
                    cancel: Effect.void,
                });
            }
        },
      } as any;

      // Mock ToolExecutor to return result
      const originalExecute = ToolExecutor.executeToolCalls;
      // Do not use async here, and return Effect directly
      ToolExecutor.executeToolCalls = mock(() => Effect.succeed([{
          toolCallId: "call_1",
          name: "test_tool",
          result: "tool output",
          success: true
      }]));

      // Setup Context (same as above)
      const options: AgentRunnerOptions = {
          sessionId: "test-session",
          agent: {
              id: "agent-1",
              name: "test-agent",
              config: {
                  model: "gpt-4",
                  provider: "openai",
                  reasoningEffort: "medium",
                  systemPrompt: "system",
              },
              prompts: { system: "system prompt" },
          } as any,
          maxIterations: 5,
          userInput: "run tool",
      };

      const runContext: AgentRunContext = {
          actualConversationId: "conv-123",
          context: {
              agentId: "agent-1",
              workingDirectory: "/tmp",
              variables: {},
          },
          tools: [],
          messages: [{ role: "user", content: "run tool" }],
          runMetrics: {
              startedAt: new Date(),
              toolCalls: [],
              toolCallCounts: {},
              toolsUsed: new Set(),
              totalPromptTokens: 0,
              totalCompletionTokens: 0,
              iterationSummaries: [],
              errors: [],
              metrics: { totalDuration: 0, totalLLMDuration: 0, totalToolDuration: 0, inputTokens: 0, outputTokens: 0, totalCost: 0 },
          } as any,
          provider: "openai",
          model: "gpt-4",
          agent: options.agent,
          expandedToolNames: [],
          connectedMCPServers: [],
      };

      const displayConfig = { showThinking: false, showToolExecution: false, mode: "markdown" as const };
      const streamingConfig = { enabled: true };
      const runRecursive: RecursiveRunner = () => Effect.succeed({ content: "recursive", conversationId: "id" } as any);

      const TestLayer = Layer.mergeAll(
          Layer.succeed(LoggerServiceTag, mockLogger),
          Layer.succeed(PresentationServiceTag, mockPresentationService),
          Layer.succeed(LLMServiceTag, mockLLMServiceWithTools),
          Layer.succeed(ToolRegistryTag, mockToolRegistry),
          Layer.succeed(MCPServerManagerTag, mockMCPServerManager),
          Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
          Layer.succeed(FileSystem.FileSystem, mockFileSystem),
          Layer.succeed(TerminalServiceTag, mockTerminalService),
          Layer.succeed(GmailServiceTag, mockGmailService),
          Layer.succeed(CalendarServiceTag, mockCalendarService),
          Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext)
      );

      const program = executeWithStreaming(
          options,
          runContext,
          displayConfig,
          streamingConfig,
          false,
          runRecursive
      );

      const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));

      expect(result.content).toBe("Tool executed");
      // Verify tool executor was called
      expect(ToolExecutor.executeToolCalls).toHaveBeenCalled();

      // Restore original
      ToolExecutor.executeToolCalls = originalExecute;
  });
});
