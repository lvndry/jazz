import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  buildBudgetPressureMessage,
  detectMeltdown,
  executeAgentLoop,
  type CompletionStrategy,
  type TrackedToolCall,
} from "./agent-loop";
import { ToolExecutor } from "./tool-executor";
import { SkillServiceTag } from "../../../core/skills/skill-service";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { RecursiveRunner } from "../context/summarizer";
import type { AgentRunContext, AgentRunnerOptions, AgentResponse } from "../types";

// Shared mocks
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
  formatToolExecutionStart: () => Effect.succeed("Starting tool"),
  formatToolExecutionComplete: () => Effect.succeed("Tool completed"),
  formatToolResult: () => "Tool result",
  formatToolExecutionError: () => Effect.succeed("Tool failed"),
  presentAgentResponse: () => Effect.void,
  presentWarning: () => Effect.void,
  renderMarkdown: (c: string) => Effect.succeed(c),
  signalToolExecutionStarted: () => Effect.void,
  requestApproval: () => Effect.succeed({ approved: true }),
} as any;

const mockToolRegistry = {
  getTool: () => Effect.succeed({ approvalExecuteToolName: undefined }),
  listTools: () => Effect.succeed([]),
  getToolDefinitions: () => Effect.succeed([]),
  executeTool: () => Effect.succeed({ success: true, result: "ok" }),
} as any;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as any;

const mockLLMService: LLMService = {
  createStreamingChatCompletion: () => Effect.fail(new Error("not implemented")),
  createChatCompletion: () => Effect.fail(new Error("not implemented")),
  listProviders: () => Effect.succeed([]),
  getProvider: () => Effect.fail(new Error("not implemented")),
  supportsNativeWebSearch: () => Effect.succeed(false),
} as unknown as LLMService;

const mockSkillService = {
  listSkills: () => Effect.succeed([]),
  loadSkill: () => Effect.fail(new Error("not implemented")),
  loadSkillSection: () => Effect.fail(new Error("not implemented")),
} as any;

const TestLayer = Layer.mergeAll(
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(PresentationServiceTag, mockPresentationService),
  Layer.succeed(LLMServiceTag, mockLLMService),
  Layer.succeed(ToolRegistryTag, mockToolRegistry),
  Layer.succeed(MCPServerManagerTag, {} as any),
  Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
  Layer.succeed(FileSystem.FileSystem, {} as any),
  Layer.succeed(TerminalServiceTag, {} as any),
  Layer.succeed(FileSystemContextServiceTag, {} as any),
  Layer.succeed(SkillServiceTag, mockSkillService),
);

function makeOptions(overrides?: Partial<AgentRunnerOptions>): AgentRunnerOptions {
  return {
    sessionId: "test-session",
    agent: {
      id: "agent-1",
      name: "test-agent",
      config: {
        persona: "default",
        llmModel: "gpt-4",
        llmProvider: "openai",
        reasoningEffort: "medium",
      },
    } as any,
    userInput: "hello",
    ...overrides,
  };
}

function makeRunContext(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    actualConversationId: "conv-123",
    context: { agentId: "agent-1", conversationId: "conv-123" },
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
    agent: {
      id: "agent-1",
      name: "test-agent",
      config: {
        persona: "default",
        llmModel: "gpt-4",
        llmProvider: "openai",
        reasoningEffort: "medium",
      },
    } as any,
    expandedToolNames: [],
    connectedMCPServers: [],
    knownSkills: [],
    ...overrides,
  };
}

const displayConfig = { showThinking: false, showToolExecution: false, mode: "markdown" as const };
const runRecursive: RecursiveRunner = () =>
  Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

describe("executeAgentLoop", () => {
  it("should return content from a simple completion", async () => {
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "gpt-4", content: "Hello world" },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(TestLayer),
      ),
    );

    expect(result.content).toBe("Hello world");
    expect(result.conversationId).toBe("conv-123");
  });

  it("should handle tool calls and continue", async () => {
    let iteration = 0;
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () => {
        iteration++;
        if (iteration === 1) {
          return Effect.succeed({
            completion: {
              id: "c1",
              model: "gpt-4",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "test_tool", arguments: "{}" },
                },
              ],
            },
            interrupted: false,
          });
        }
        return Effect.succeed({
          completion: { id: "c2", model: "gpt-4", content: "Done with tools" },
          interrupted: false,
        });
      },
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    // Mock ToolExecutor
    const originalExecute = ToolExecutor.executeToolCalls;
    ToolExecutor.executeToolCalls = mock(() =>
      Effect.succeed([
        { toolCallId: "call_1", name: "test_tool", result: "output", success: true },
      ]),
    );

    const result = await Effect.runPromise(
      executeAgentLoop(
        makeOptions({ maxIterations: 5 }),
        makeRunContext(),
        displayConfig,
        strategy,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(result.content).toBe("Done with tools");
    expect(ToolExecutor.executeToolCalls).toHaveBeenCalled();

    ToolExecutor.executeToolCalls = originalExecute;
  });

  it("should warn when iteration limit is reached", async () => {
    const warningCalls: string[] = [];
    const trackingPresentationService = {
      ...mockPresentationService,
      presentWarning: (_name: string, msg: string) => {
        warningCalls.push(msg);
        return Effect.void;
      },
    };

    // Strategy that always returns tool calls (never finishes)
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "gpt-4",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                type: "function" as const,
                function: { name: "test_tool", arguments: "{}" },
              },
            ],
          },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const originalExecute = ToolExecutor.executeToolCalls;
    ToolExecutor.executeToolCalls = mock(() =>
      Effect.succeed([
        { toolCallId: "call_1", name: "test_tool", result: "output", success: true },
      ]),
    );

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, trackingPresentationService as any),
      Layer.succeed(LLMServiceTag, mockLLMService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(MCPServerManagerTag, {} as any),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
    );

    await Effect.runPromise(
      executeAgentLoop(
        makeOptions({ maxIterations: 2 }),
        makeRunContext(),
        displayConfig,
        strategy,
        runRecursive,
      ).pipe(Effect.provide(testLayer)),
    );

    expect(warningCalls.some((msg) => msg.includes("iteration limit reached"))).toBe(true);

    ToolExecutor.executeToolCalls = originalExecute;
  });

  it("should handle interruption from strategy", async () => {
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "gpt-4", content: "partial" },
          interrupted: true,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(TestLayer),
      ),
    );

    expect(result.content).toBe("partial");
  });

  it("should warn on empty response", async () => {
    const warningCalls: string[] = [];
    const trackingPresentationService = {
      ...mockPresentationService,
      presentWarning: (_name: string, msg: string) => {
        warningCalls.push(msg);
        return Effect.void;
      },
    };

    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "gpt-4", content: "" },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, trackingPresentationService as any),
      Layer.succeed(LLMServiceTag, mockLLMService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(MCPServerManagerTag, {} as any),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
    );

    await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(testLayer),
      ),
    );

    expect(warningCalls.some((msg) => msg.includes("empty response"))).toBe(true);
  });

  it("does not warn empty when the model produced reasoning but no content", async () => {
    const warningCalls: string[] = [];
    let presentedResponseContent = "";
    const trackingPresentationService = {
      ...mockPresentationService,
      presentWarning: (_name: string, msg: string) => {
        warningCalls.push(msg);
        return Effect.void;
      },
    };

    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "llamacpp/qwen",
            content: "",
            reasoning: "the answer is 42",
          },
          interrupted: false,
        }),
      presentResponse: (_agentName, content) => {
        presentedResponseContent = content;
        return Effect.void;
      },
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, trackingPresentationService as any),
      Layer.succeed(LLMServiceTag, mockLLMService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(MCPServerManagerTag, {} as any),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
    );

    const result = await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(testLayer),
      ),
    );

    expect(warningCalls.some((msg) => msg.includes("empty response"))).toBe(false);
    // Reasoning text becomes the visible content for downstream consumers.
    expect(result.content).toBe("the answer is 42");
    expect(result.reasoning).toBe("the answer is 42");
    expect(presentedResponseContent).toBe("the answer is 42");
  });

  it("should record token usage from completions", async () => {
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "gpt-4",
            content: "Hello",
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(TestLayer),
      ),
    );

    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(5);
  });

  it("should set toolsDisabled when completion indicates it", async () => {
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "gpt-4",
            content: "No tools",
            toolsDisabled: true,
          },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(makeOptions(), makeRunContext(), displayConfig, strategy, runRecursive).pipe(
        Effect.provide(TestLayer),
      ),
    );

    expect(result.toolsDisabled).toBe(true);
  });
});

describe("buildBudgetPressureMessage", () => {
  it("returns null below 70%", () => {
    expect(buildBudgetPressureMessage(10, 60)).toBeNull();
    expect(buildBudgetPressureMessage(41, 60)).toBeNull();
  });

  it("returns caution message at 70%", () => {
    const msg = buildBudgetPressureMessage(42, 60);
    expect(msg).not.toBeNull();
    expect(msg?.content).toContain("70%");
    expect(msg?.content).toContain("consolidat");
  });

  it("returns critical message at 90%", () => {
    const msg = buildBudgetPressureMessage(54, 60);
    expect(msg).not.toBeNull();
    expect(msg?.content).toContain("CRITICAL");
    expect(msg?.content).toContain("NOW");
  });

  it("returns critical at exact 90% boundary", () => {
    const msg = buildBudgetPressureMessage(54, 60);
    expect(msg?.content).toContain("CRITICAL");
  });
});

function tc(name: string, args: Record<string, unknown> = {}): TrackedToolCall {
  return { name, arguments: JSON.stringify(args) };
}

describe("detectMeltdown", () => {
  it("returns false with fewer than 10 calls", () => {
    const calls = Array.from({ length: 3 }, () => tc("web_search", { query: "foo" }));
    expect(detectMeltdown(calls)).toBe(false);
  });

  it("returns false with diverse tool names and arguments", () => {
    const calls: TrackedToolCall[] = [
      tc("web_search", { query: "topic A" }),
      tc("web_fetch", { url: "https://a.com" }),
      tc("web_search", { query: "topic B" }),
      tc("web_fetch", { url: "https://b.com" }),
      tc("write_file", { path: "out.txt" }),
      tc("web_search", { query: "topic C" }),
      tc("web_fetch", { url: "https://c.com" }),
      tc("spawn_subagent", { task: "summarise" }),
      tc("web_search", { query: "topic D" }),
      tc("web_fetch", { url: "https://d.com" }),
    ];
    expect(detectMeltdown(calls)).toBe(false);
  });

  it("returns false for two tools alternating with different arguments each time", () => {
    // Simulates a legitimate web_search → web_fetch research loop where every
    // call has unique arguments — previously a false positive under name-only check.
    const calls: TrackedToolCall[] = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? tc("web_search", { query: `query ${i}` })
        : tc("web_fetch", { url: `https://example.com/${i}` }),
    );
    expect(detectMeltdown(calls)).toBe(false);
  });

  it("returns true when the same name+arguments pair is repeated throughout the window", () => {
    const calls: TrackedToolCall[] = [
      ...Array(9).fill(tc("web_search", { query: "same query" })),
      tc("web_fetch", { url: "https://example.com" }),
    ];
    expect(detectMeltdown(calls)).toBe(true);
  });

  it("returns true when two tools alternate with identical arguments each time", () => {
    // The agent alternates but is making the exact same calls — genuine loop.
    const calls: TrackedToolCall[] = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? tc("web_search", { query: "stuck query" })
        : tc("web_fetch", { url: "https://stuck.com" }),
    );
    expect(detectMeltdown(calls)).toBe(true);
  });

  it("uses only the last 10 calls for the window", () => {
    const diverse = Array.from({ length: 20 }, (_, i) =>
      tc("web_search", { query: `unique ${i}` }),
    );
    const meltdown = Array(10).fill(tc("web_search", { query: "stuck" })) as TrackedToolCall[];
    expect(detectMeltdown([...diverse, ...meltdown])).toBe(true);
  });
});
