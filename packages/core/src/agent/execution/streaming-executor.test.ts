import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { Stream } from "effect";
import { executeWithStreaming } from "./streaming-executor";
import { ToolExecutor } from "./tool-executor";
import { DEFAULT_MAX_ITERATIONS } from "../../constants/agent";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import { GoalStoreTag } from "../../interfaces/goal-store";
import { JobQueueServiceTag } from "../../interfaces/job-queue-service";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { MemoryServiceTag } from "../../interfaces/memory-service";
import { PeerLedgerServiceTag, PeerTokenServiceTag } from "../../interfaces/peers";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { ReminderServiceTag } from "../../interfaces/reminder-service";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import { WakeTriggerServiceTag } from "../../interfaces/wake-trigger-service";
import { WorkspaceServiceTag } from "../../interfaces/workspace-service";
import { SkillServiceTag } from "../../skills/skill-service";
import { LLMRateLimitError, LLMRequestError } from "../../types/errors";
import type { RecursiveRunner } from "../context/summarizer";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import type { AgentRunContext, AgentRunnerOptions, AgentResponse } from "../types";

// Mocks
const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
} as any;

const mockPresentationService = {
  createStreamingRenderer: () =>
    Effect.succeed({
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
  writeError: () => Effect.void,
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
  presentStatus: () => Effect.void,
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
const mockFileSystemContext = {} as any;
const mockSkillService = {
  listSkills: () => Effect.succeed([]),
  loadSkill: () => Effect.fail(new Error("not implemented")),
  loadSkillSection: () => Effect.fail(new Error("not implemented")),
} as any;

describe("executeWithStreaming", () => {
  it("retries a retryable stream failure and completes", async () => {
    // Setup Context
    const options: AgentRunnerOptions = {
      conversationId: "test-session",
      agent: {
        id: "agent-1",
        name: "test-agent",
        config: {
          persona: "default",
          llm: { provider: "openai", model: "gpt-4" },
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
        unrestrictedTools: true,
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
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxCostUSD: undefined,
      maxTokens: undefined,
      maxDurationMs: undefined,
      maxRetries: 1,
    };

    const displayConfig = {
      showReasoning: false,
      showToolExecution: false,
      mode: "hybrid" as const,
    };
    const streamingConfig = { enabled: true };
    const showMetrics = false;
    const runRecursive: RecursiveRunner = () =>
      Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

    let attempts = 0;
    const artifact = {
      kind: "image" as const,
      path: "/tmp/generated.png",
      mediaType: "image/png",
      tool: "image-model",
      source: "model" as const,
    };
    const mockLLMService: LLMService = {
      createStreamingChatCompletion: () => {
        attempts += 1;
        return Effect.succeed({
          stream:
            attempts === 1
              ? Stream.fail(new LLMRequestError({ provider: "openai", message: "stream stalled" }))
              : Stream.fromIterable([
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
          response:
            attempts === 1
              ? Effect.fail(new LLMRequestError({ provider: "openai", message: "stream stalled" }))
              : Effect.succeed({
                  id: "test",
                  model: "gpt-4",
                  content: "Hello world",
                  toolCalls: [],
                  artifacts: [artifact],
                }),
          cancel: Effect.void,
        });
      },
      createChatCompletion: () => Effect.fail(new Error("")),
      listProviders: () => Effect.succeed([]),
      getProvider: () => Effect.fail(new Error("")),
      supportsNativeWebSearch: () => Effect.succeed(false),
      resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
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
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(MemoryServiceTag, {} as any),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, {} as any),
      Layer.succeed(GoalStoreTag, {} as any),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    // Run Effect
    const program = executeWithStreaming(
      options,
      runContext,
      displayConfig,
      streamingConfig,
      showMetrics,
      runRecursive,
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));

    expect(result.content).toBe("Hello world");
    expect(result.conversationId).toBe("conv-123");
    expect(result.artifacts).toEqual([artifact]);
    expect(attempts).toBe(2);
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
                  function: { name: "test_tool", arguments: "{}" },
                },
                sequence: 0,
              },
              {
                type: "complete",
                response: {
                  id: "test",
                  model: "gpt-4",
                  content: "",
                  toolCalls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "test_tool", arguments: "{}" },
                    },
                  ],
                },
              },
            ]),
            response: Effect.succeed({
              id: "test",
              model: "gpt-4",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "test_tool", arguments: "{}" },
                },
              ],
            }),
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
              },
            ]),
            response: Effect.succeed({
              id: "test",
              model: "gpt-4",
              content: "Tool executed",
              toolCalls: [],
            }),
            cancel: Effect.void,
          });
        }
      },
    } as unknown as LLMService;

    // Mock ToolExecutor to return result
    const originalExecute = ToolExecutor.executeToolCalls;
    // Do not use async here, and return Effect directly
    ToolExecutor.executeToolCalls = mock(() =>
      Effect.succeed([
        {
          toolCallId: "call_1",
          name: "test_tool",
          result: "tool output",
          success: true,
        },
      ]),
    );

    // Setup Context (same as above)
    const options: AgentRunnerOptions = {
      conversationId: "test-session",
      agent: {
        id: "agent-1",
        name: "test-agent",
        config: {
          persona: "default",
          llm: { provider: "openai", model: "gpt-4" },
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
        unrestrictedTools: true,
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
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxCostUSD: undefined,
      maxTokens: undefined,
      maxDurationMs: undefined,
    };

    const displayConfig = {
      showReasoning: false,
      showToolExecution: false,
      mode: "hybrid" as const,
    };
    const streamingConfig = { enabled: true };
    const runRecursive: RecursiveRunner = () =>
      Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

    const TestLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(LLMServiceTag, mockLLMServiceWithTools),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(MCPServerManagerTag, mockMCPServerManager),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(MemoryServiceTag, {} as any),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, {} as any),
      Layer.succeed(GoalStoreTag, {} as any),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const program = executeWithStreaming(
      options,
      runContext,
      displayConfig,
      streamingConfig,
      false,
      runRecursive,
    );

    const result = await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));

    expect(result.content).toBe("Tool executed");
    // Verify tool executor was called
    expect(ToolExecutor.executeToolCalls).toHaveBeenCalled();

    // Restore original
    ToolExecutor.executeToolCalls = originalExecute;
  });

  it("clears interrupt handler only after run completion", async () => {
    const interruptCalls: Array<(() => void) | null> = [];
    const renderer = {
      handleEvent: () => Effect.void,
      setInterruptHandler: (handler: (() => void) | null) =>
        Effect.sync(() => {
          interruptCalls.push(handler);
        }),
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

    const presentationService = {
      ...mockPresentationService,
      createStreamingRenderer: () => Effect.succeed(renderer),
    } as any;

    const options: AgentRunnerOptions = {
      conversationId: "test-session",
      agent: {
        id: "agent-1",
        name: "test-agent",
        config: {
          persona: "default",
          llm: { provider: "openai", model: "gpt-4" },
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
        unrestrictedTools: true,
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
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxCostUSD: undefined,
      maxTokens: undefined,
      maxDurationMs: undefined,
    };

    const mockLLMService: LLMService = {
      createStreamingChatCompletion: () =>
        Effect.succeed({
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
              },
            },
          ]),
          response: Effect.succeed({
            id: "test",
            model: "gpt-4",
            content: "Hello world",
            toolCalls: [],
          }),
          cancel: Effect.void,
        }),
      createChatCompletion: () => Effect.fail(new Error("")),
      listProviders: () => Effect.succeed([]),
      getProvider: () => Effect.fail(new Error("")),
      supportsNativeWebSearch: () => Effect.succeed(false),
      resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
    } as unknown as LLMService;

    const TestLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, presentationService),
      Layer.succeed(LLMServiceTag, mockLLMService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(MCPServerManagerTag, mockMCPServerManager),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(MemoryServiceTag, {} as any),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, {} as any),
      Layer.succeed(GoalStoreTag, {} as any),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const program = executeWithStreaming(
      options,
      runContext,
      { showReasoning: false, showToolExecution: false, mode: "hybrid" },
      { enabled: true },
      false,
      () => Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse),
    );

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));

    expect(interruptCalls.length).toBeGreaterThanOrEqual(2);
    expect(typeof interruptCalls[0]).toBe("function");
    expect(interruptCalls[interruptCalls.length - 1]).toBeNull();
  });
});

/**
 * A streaming run against a scripted LLM service, with the renderer's interrupt handler exposed
 * so a test can press Esc at a chosen moment.
 */
function makeStreamingHarness(input: {
  readonly llmService: LLMService;
  readonly maxRetries?: number;
  readonly maxDurationMs?: number;
}) {
  const interrupt: { current: (() => void) | null } = { current: null };
  const renderer = {
    handleEvent: () => Effect.void,
    setInterruptHandler: (handler: (() => void) | null) =>
      Effect.sync(() => {
        if (handler !== null) {
          interrupt.current = handler;
        }
      }),
    reset: () => Effect.void,
    flush: () => Effect.void,
  };
  const presentationService = {
    ...mockPresentationService,
    createStreamingRenderer: () => Effect.succeed(renderer),
  } as any;
  const agent = {
    id: "agent-1",
    name: "test-agent",
    config: { persona: "default", llm: { provider: "openai", model: "gpt-4" } },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
  const options: AgentRunnerOptions = { conversationId: "conv-1", agent, userInput: "hello" };
  const runContext: AgentRunContext = {
    actualConversationId: "conv-1",
    context: { agentId: "agent-1", conversationId: "conv-1", unrestrictedTools: true },
    tools: [],
    messages: [{ role: "user", content: "hello" }],
    runMetrics: createAgentRunMetrics({
      agent,
      conversationId: "conv-1",
      provider: "openai",
      model: "gpt-4",
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxCostUSD: undefined,
    }),
    provider: "openai",
    model: "gpt-4",
    agent,
    expandedToolNames: [],
    connectedMCPServers: [],
    knownSkills: [],
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxCostUSD: undefined,
    maxTokens: undefined,
    maxDurationMs: input.maxDurationMs,
    maxRetries: input.maxRetries ?? 1,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(PresentationServiceTag, presentationService),
    Layer.succeed(LLMServiceTag, input.llmService),
    Layer.succeed(ToolRegistryTag, mockToolRegistry),
    Layer.succeed(MCPServerManagerTag, mockMCPServerManager),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    Layer.succeed(FileSystem.FileSystem, mockFileSystem),
    Layer.succeed(TerminalServiceTag, mockTerminalService),
    Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext),
    Layer.succeed(SkillServiceTag, mockSkillService),
    Layer.succeed(MemoryServiceTag, {} as any),
    Layer.succeed(WorkspaceServiceTag, {} as any),
    Layer.succeed(WakeTriggerServiceTag, {} as any),
    Layer.succeed(JobQueueServiceTag, {} as any),
    Layer.succeed(ReminderServiceTag, {} as any),
    Layer.succeed(GoalStoreTag, {} as any),
    Layer.succeed(PeerLedgerServiceTag, {} as any),
    Layer.succeed(PeerTokenServiceTag, {} as any),
  );
  const run = () =>
    Effect.runPromise(
      executeWithStreaming(
        options,
        runContext,
        { showReasoning: false, showToolExecution: false, mode: "hybrid" },
        { enabled: true },
        false,
        () => Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse),
      ).pipe(Effect.provide(layer)),
    );
  return { run, interrupt };
}

/** A stream that never emits, recording when its consumer abandons it. */
function hangingStream(onAbandoned: () => void): Stream.Stream<never, never> {
  return Stream.async<never, never>(() => Effect.sync(onAbandoned));
}

function scriptedLLMService(
  createStreamingChatCompletion: LLMService["createStreamingChatCompletion"],
  createChatCompletion: LLMService["createChatCompletion"] = () =>
    Effect.fail(new LLMRequestError({ provider: "openai", message: "unused" })),
): LLMService {
  return {
    createStreamingChatCompletion,
    createChatCompletion,
    listProviders: () => Effect.succeed([]),
    getProvider: () => Effect.fail(new Error("")),
    supportsNativeWebSearch: () => Effect.succeed(false),
    resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
  } as unknown as LLMService;
}

describe("executeWithStreaming cancellation", () => {
  it("Esc during retry backoff stops the run without waiting out the backoff", async () => {
    let attempts = 0;
    const harness = makeStreamingHarness({
      maxRetries: 5,
      llmService: scriptedLLMService(() => {
        attempts += 1;
        return Effect.succeed({
          stream: Stream.fail(new LLMRequestError({ provider: "openai", message: "overloaded" })),
          response: Effect.fail(new LLMRequestError({ provider: "openai", message: "overloaded" })),
          cancel: Effect.void,
        });
      }),
    });

    const startedAt = Date.now();
    const pending = harness.run();
    await Bun.sleep(200);
    harness.interrupt.current?.();
    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(attempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it("Esc during a stalled stream abandons the stream so its provider request is aborted", async () => {
    let abandoned = 0;
    const harness = makeStreamingHarness({
      llmService: scriptedLLMService(() =>
        Effect.succeed({
          stream: hangingStream(() => {
            abandoned += 1;
          }),
          response: Effect.never,
          cancel: Effect.void,
        }),
      ),
    });

    const pending = harness.run();
    await Bun.sleep(100);
    harness.interrupt.current?.();
    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(abandoned).toBe(1);
  });

  it("Esc during the non-streaming fallback stops the run", async () => {
    let fallbackAbandoned = 0;
    const stalled = new LLMRequestError({
      provider: "openai",
      message: "stalled",
      retryAfterMs: 0,
    });
    const harness = makeStreamingHarness({
      maxRetries: 5,
      llmService: scriptedLLMService(
        () =>
          Effect.succeed({
            stream: Stream.fail(stalled),
            response: Effect.fail(stalled),
            cancel: Effect.void,
          }),
        () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                fallbackAbandoned += 1;
              }),
            ),
          ),
      ),
    });

    const pending = harness.run();
    await Bun.sleep(100);
    harness.interrupt.current?.();
    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(fallbackAbandoned).toBe(1);
  });

  it("the run's time budget stops a model call that never finishes", async () => {
    let abandoned = 0;
    const harness = makeStreamingHarness({
      maxDurationMs: 300,
      llmService: scriptedLLMService(() =>
        Effect.succeed({
          stream: hangingStream(() => {
            abandoned += 1;
          }),
          response: Effect.never,
          cancel: Effect.void,
        }),
      ),
    });

    const startedAt = Date.now();
    const result = await harness.run();

    expect(result.durationCapped).toBe(true);
    expect(abandoned).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("executeWithStreaming retries", () => {
  const completeResponse = (content: string) => ({
    id: "fallback",
    model: "gpt-4",
    content,
    toolCalls: [],
  });

  function failingStream(error: unknown) {
    return Effect.succeed({
      stream: Stream.fail(error as LLMRequestError),
      response: Effect.fail(error as LLMRequestError),
      cancel: Effect.void,
    });
  }

  it("shares one retry budget between streaming and the non-streaming fallback", async () => {
    let streamingAttempts = 0;
    let fallbackAttempts = 0;
    const transient = new LLMRequestError({
      provider: "openai",
      message: "overloaded",
      statusCode: 503,
      retryAfterMs: 0,
    });
    const harness = makeStreamingHarness({
      maxRetries: 5,
      llmService: scriptedLLMService(
        () => {
          streamingAttempts += 1;
          return failingStream(transient);
        },
        () => {
          fallbackAttempts += 1;
          return Effect.fail(transient);
        },
      ),
    });

    await expect(harness.run()).rejects.toThrow("overloaded");
    expect(streamingAttempts + fallbackAttempts).toBe(6);
    expect(fallbackAttempts).toBeGreaterThan(0);
  });

  it("answers from the fallback once streaming keeps failing", async () => {
    let fallbackAttempts = 0;
    const stalled = new LLMRequestError({
      provider: "openai",
      message: "stalled",
      retryAfterMs: 0,
    });
    const harness = makeStreamingHarness({
      maxRetries: 5,
      llmService: scriptedLLMService(
        () => failingStream(stalled),
        () => {
          fallbackAttempts += 1;
          return Effect.succeed(completeResponse("from the fallback"));
        },
      ),
    });

    const result = await harness.run();

    expect(result.content).toBe("from the fallback");
    expect(fallbackAttempts).toBe(1);
  });

  it("never falls back to non-streaming for a rate limit", async () => {
    let streamingAttempts = 0;
    let fallbackAttempts = 0;
    const throttled = new LLMRateLimitError({
      provider: "openai",
      message: "rate limited",
      retryAfterMs: 0,
    });
    const harness = makeStreamingHarness({
      maxRetries: 4,
      llmService: scriptedLLMService(
        () => {
          streamingAttempts += 1;
          return failingStream(throttled);
        },
        () => {
          fallbackAttempts += 1;
          return Effect.succeed(completeResponse("unused"));
        },
      ),
    });

    await expect(harness.run()).rejects.toThrow("rate limited");
    expect(streamingAttempts).toBe(5);
    expect(fallbackAttempts).toBe(0);
  });

  it("waits as long as the provider's Retry-After asks", async () => {
    let attempts = 0;
    const harness = makeStreamingHarness({
      maxRetries: 2,
      llmService: scriptedLLMService(() => {
        attempts += 1;
        if (attempts === 1) {
          return failingStream(
            new LLMRateLimitError({ provider: "openai", message: "slow down", retryAfterMs: 400 }),
          );
        }
        return Effect.succeed({
          stream: Stream.fromIterable([
            {
              type: "complete" as const,
              response: completeResponse("after waiting"),
              totalDurationMs: 1,
            },
          ]),
          response: Effect.succeed(completeResponse("after waiting")),
          cancel: Effect.void,
        });
      }),
    });

    const startedAt = Date.now();
    const result = await harness.run();

    expect(result.content).toBe("after waiting");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(390);
  });

  it("gives up at once when the provider asks for a longer wait than Jazz will sleep", async () => {
    let attempts = 0;
    const harness = makeStreamingHarness({
      maxRetries: 3,
      llmService: scriptedLLMService(() => {
        attempts += 1;
        return failingStream(
          new LLMRateLimitError({
            provider: "openai",
            message: "come back in an hour",
            retryAfterMs: 3_600_000,
          }),
        );
      }),
    });

    await expect(harness.run()).rejects.toThrow("come back in an hour");
    expect(attempts).toBe(1);
  });

  it("does not retry a request the provider rejected", async () => {
    let attempts = 0;
    const harness = makeStreamingHarness({
      maxRetries: 3,
      llmService: scriptedLLMService(() => {
        attempts += 1;
        return failingStream(
          new LLMRequestError({ provider: "openai", message: "bad request", statusCode: 400 }),
        );
      }),
    });

    await expect(harness.run()).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });
});
