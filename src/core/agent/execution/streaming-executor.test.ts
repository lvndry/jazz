import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { Stream } from "effect";
import { executeWithStreaming } from "./streaming-executor";
import { ToolExecutor } from "./tool-executor";
import { SkillServiceTag } from "../../../core/skills/skill-service";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { CalendarServiceTag } from "../../interfaces/calendar";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import { GmailServiceTag } from "../../interfaces/gmail";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { RecursiveRunner } from "../context/summarizer";
import type {
  AgentRunContext,
  AgentRunnerOptions,
  AgentResponse,
} from "../types";

// Mocks
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

const mockPresentationService = {
  createStreamingRenderer: () => Effect.succeed({
    renderEvent: () => Effect.void,
    stop: () => Effect.void,
    handleEvent: () => Effect.void,
    setInterruptHandler: () => Effect.void,
    reset: () => Effect.void,
    flush: () => Effect.void,
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
  presentAgentResponse: () => Effect.void,
  presentWarning: () => Effect.void,
  renderMarkdown: (c: string) => Effect.succeed(c),
  formatThinking: () => Effect.succeed(""),
  formatCompletion: () => Effect.succeed(""),
  formatWarning: () => Effect.succeed(""),
  formatAgentResponse: () => Effect.succeed(""),
} as any;

const mockToolRegistry = {
  getTool: () => Effect.succeed({ approvalExecuteToolName: undefined }),
  listTools: () => Effect.succeed([]),
  getToolDefinitions: () => Effect.succeed([]),
} as any;

const mockMCPServerManager = {
  listServers: () => Effect.succeed([]),
  disconnectAllServers: () => Effect.void,
} as any;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as any;

const mockFileSystem = {} as any;
const mockTerminalService = {
  ask: () => Effect.succeed(""),
  confirm: () => Effect.succeed(true),
  log: () => Effect.void,
} as any;
const mockGmailService = {} as any;
const mockCalendarService = {} as any;
const mockFileSystemContext = {} as any;
const mockSkillService = {
  listSkills: () => Effect.succeed([]),
  loadSkill: () => Effect.fail(new Error("not implemented")),
  loadSkillSection: () => Effect.fail(new Error("not implemented")),
} as any;

describe("executeWithStreaming", () => {
  it("should execute a simple run with mocked services", async () => {
    // Setup Context
    const options: AgentRunnerOptions = {
        sessionId: "test-session",
        agent: {
            id: "agent-1",
            name: "test-agent",
            config: {
                agentType: "default",
                llmModel: "gpt-4",
                llmProvider: "openai",
                reasoningEffort: "medium",
            },
            prompts: { system: "system prompt" },
        } as any,
        userInput: "hello",
    };

    const runContext: AgentRunContext = {
        actualConversationId: "conv-123",
        context: {
            agentId: "agent-1",
            conversationId: "conv-123",
        },
        tools: [],
        messages: [{ role: "user", content: "hello" }],
        runMetrics: {
            startedAt: new Date(),
            toolCalls: 0,
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
        knownSkills: [],
    };

    const displayConfig = {
        showThinking: false,
        showToolExecution: false,
        mode: "markdown" as const,
    };
    const streamingConfig = { enabled: true };
    const showMetrics = false;
    const runRecursive: RecursiveRunner = () => Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

    const mockLLMService: LLMService = {
      createStreamingChatCompletion: () => Effect.succeed({
        stream: Stream.fromIterable([
          {
            type: "text_chunk",
            delta: "Hello world",
            accumulated: "Hello world",
            sequence: 0,
          },
          {
            type: "complete",
            response: {
              id: "test",
              model: "gpt-4",
              content: "Hello world",
              toolCalls: [],
              raw: {},
            },
            metrics: { firstTokenLatencyMs: 10 },
          },
        ]),
        cancel: Effect.void,
      }),
      createChatCompletion: () => Effect.fail(new Error("")),
      listProviders: () => Effect.succeed([]),
      getProvider: () => Effect.fail(new Error("")),
      supportsNativeWebSearch: () => Effect.succeed(false),
    } as unknown as LLMService;

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
        Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
        Layer.succeed(SkillServiceTag, mockSkillService)
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
      const mockLLMServiceWithTools: LLMService = {
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
                                type: "function",
                                function: { name: "test_tool", arguments: "{}" }
                            },
                            sequence: 0,
                        },
                        {
                            type: "complete",
                            response: {
                                id: "test",
                                model: "gpt-4",
                                content: "",
                                toolCalls: [{
                                    id: "call_1",
                                    type: "function",
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
                            type: "text_chunk",
                            delta: "Tool executed",
                            accumulated: "Tool executed",
                            sequence: 0,
                        },
                        {
                            type: "complete",
                            response: {
                                id: "test",
                                model: "gpt-4",
                                content: "Tool executed",
                                toolCalls: [],
                            },
                        }
                    ]),
                    cancel: Effect.void,
                });
            }
        },
      } as unknown as LLMService;

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
                  agentType: "default",
                  llmModel: "gpt-4",
                  llmProvider: "openai",
                  reasoningEffort: "medium",
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
              conversationId: "conv-123",
          },
          tools: [],
          messages: [{ role: "user", content: "run tool" }],
          runMetrics: {
              startedAt: new Date(),
              toolCalls: 0,
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
          knownSkills: [],
      };

      const displayConfig = { showThinking: false, showToolExecution: false, mode: "markdown" as const };
      const streamingConfig = { enabled: true };
      const runRecursive: RecursiveRunner = () => Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

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
          Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
          Layer.succeed(SkillServiceTag, mockSkillService)
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
