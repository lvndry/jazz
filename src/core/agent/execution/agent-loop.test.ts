import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { clearModelsDevCache } from "@/core/utils/models-dev";
import {
  buildBudgetPressureMessage,
  detectMeltdown,
  executeAgentLoop,
  type CompletionStrategy,
  type TrackedToolCall,
} from "./agent-loop";
import { makeDefaultObserver } from "./agent-loop-observer";
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
import { DEFAULT_TOKEN_COUNTER } from "../context/token-counter";
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

const defaultObserver = makeDefaultObserver(mockPresentationService);

// Fake observer that records lifecycle calls.
function recordingObserver() {
  const calls: string[] = [];
  const observer = {
    onThinking: (name: string, first: boolean) =>
      Effect.sync(() => void calls.push(`thinking:${name}:${first}`)),
    onInterrupted: (name: string) => Effect.sync(() => void calls.push(`interrupted:${name}`)),
    onIterationLimit: (name: string, max: number) =>
      Effect.sync(() => void calls.push(`limit:${name}:${max}`)),
    onEmptyResponse: (name: string) => Effect.sync(() => void calls.push(`empty:${name}`)),
    onContextWindowUnknown: (name: string) =>
      Effect.sync(() => void calls.push(`context-window-unknown:${name}`)),
    onContextPressure: (name: string, percentUsed: number) =>
      Effect.sync(() => void calls.push(`context-pressure:${name}:${percentUsed}`)),
    onCompletion: (name: string) => Effect.sync(() => void calls.push(`completion:${name}`)),
  };
  return { observer, calls };
}

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
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        defaultObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
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
        defaultObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(result.content).toBe("Done with tools");
    expect(ToolExecutor.executeToolCalls).toHaveBeenCalled();

    // Confirms the tool-branch ("continue") appended a tool-result message
    // to the conversation before the loop moved on to the final ("final") response.
    const toolMessage = result.messages?.find(
      (message) => message.role === "tool" && message.tool_call_id === "call_1",
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.name).toBe("test_tool");

    ToolExecutor.executeToolCalls = originalExecute;
  });

  it("warns against the agent's max context tokens before compacting", async () => {
    const warningCalls: string[] = [];
    const trackingPresentationService = {
      ...mockPresentationService,
      presentWarning: (_name: string, msg: string) => {
        warningCalls.push(msg);
        return Effect.void;
      },
    };
    const trackingObserver = makeDefaultObserver(trackingPresentationService as any);

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

    const messages = [
      { role: "system" as const, content: "system prompt" },
      {
        role: "user" as const,
        content: "the quick brown fox jumps over the lazy dog. ".repeat(200),
      },
    ];
    const usedTokens = DEFAULT_TOKEN_COUNTER.countMessages(messages, {
      provider: "openai",
      modelId: "gpt-4",
    });
    // Sit at 75% of the ceiling: past the warn threshold, short of compaction.
    const maxContextTokens = Math.ceil(usedTokens / 0.75);

    const options = makeOptions();
    const agentWithCeiling = {
      ...options.agent,
      config: { ...options.agent.config, maxContextTokens },
    } as any;

    await Effect.runPromise(
      executeAgentLoop(
        { ...options, agent: agentWithCeiling },
        makeRunContext({ messages: messages as any, agent: agentWithCeiling }),
        displayConfig,
        strategy,
        trackingObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    const pressureWarning = warningCalls.find((msg) => msg.includes("context "));
    expect(pressureWarning).toBeDefined();
    expect(pressureWarning).toContain(`${maxContextTokens.toLocaleString()} tokens`);
    expect(warningCalls.some((msg) => msg.includes("auto-compacting"))).toBe(false);
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
    const trackingObserver = makeDefaultObserver(trackingPresentationService as any);

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
        trackingObserver,
        runRecursive,
      ).pipe(Effect.provide(testLayer)),
    );

    expect(warningCalls.some((msg) => msg.includes("iteration limit reached"))).toBe(true);

    ToolExecutor.executeToolCalls = originalExecute;
  });

  it("should handle interruption from strategy", async () => {
    let getCompletionCalls = 0;
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () => {
        getCompletionCalls++;
        return Effect.succeed({
          completion: { id: "c1", model: "gpt-4", content: "partial" },
          interrupted: true,
        });
      },
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const { observer, calls } = recordingObserver();

    const result = await Effect.runPromise(
      executeAgentLoop(
        makeOptions({ maxIterations: 5 }),
        makeRunContext(),
        displayConfig,
        strategy,
        observer,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(result.content).toBe("partial");
    // Interruption must fire the observer callback and stop the loop immediately
    // rather than continuing on to further iterations.
    expect(calls).toContain("interrupted:test-agent");
    expect(getCompletionCalls).toBe(1);
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
    const trackingObserver = makeDefaultObserver(trackingPresentationService as any);

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
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        trackingObserver,
        runRecursive,
      ).pipe(Effect.provide(testLayer)),
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
    const trackingObserver = makeDefaultObserver(trackingPresentationService as any);

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
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        trackingObserver,
        runRecursive,
      ).pipe(Effect.provide(testLayer)),
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
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        defaultObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
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
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        defaultObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(result.toolsDisabled).toBe(true);
  });

  it("returns usage from runMetrics and omits costUSD when pricing metadata is unavailable", async () => {
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "gpt-4",
            content: "Final answer",
            usage: { promptTokens: 42, completionTokens: 17, totalTokens: 59 },
          },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(
        makeOptions(),
        // Use a provider/model combo absent from models.dev so pricing metadata
        // resolves to undefined deterministically, without depending on network access.
        makeRunContext({ provider: "test-provider", model: "totally-fake-model-xyz" }),
        displayConfig,
        strategy,
        defaultObserver,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 17 });
    expect(result.costUSD).toBeUndefined();
    expect(result.messages).toBeDefined();
  });

  it("emits onThinking and onCompletion through the observer for a simple completion", async () => {
    const { observer, calls } = recordingObserver();
    const strategy: CompletionStrategy = {
      shouldShowThinking: true,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "gpt-4", content: "Hello world" },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    await Effect.runPromise(
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        observer,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(calls).toContain("thinking:test-agent:true");
    expect(calls).toContain("completion:test-agent");
  });

  it("stores reasoning parts on the assistant message in conversation history", async () => {
    const { observer } = recordingObserver();
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: {
            id: "c1",
            model: "gpt-4",
            content: "Final answer",
            reasoningParts: [
              {
                text: "chain of thought",
                provider: "openai",
                providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
              },
            ],
          },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    const result = await Effect.runPromise(
      executeAgentLoop(
        makeOptions(),
        makeRunContext(),
        displayConfig,
        strategy,
        observer,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    const assistantMessage = result.messages?.find((message) => message.role === "assistant");
    expect(assistantMessage?.reasoning_parts).toEqual([
      {
        text: "chain of thought",
        provider: "openai",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
    ]);
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

// qwen3.6:27b advertises 262144 tokens, but the Ollama host that serves it runs a
// smaller runtime window. Accounting against the advertised number defers compaction
// past the point the server starts silently dropping the middle of the conversation.
describe("executeAgentLoop context window accounting", () => {
  const MODEL_MAX_TOKENS = 262144;
  const PINNED_CONTEXT_WINDOW = 131072;

  const modelsDevCatalog = {
    ollama: {
      models: {
        "qwen3.6:27b": {
          name: "Qwen3.6 27B",
          limit: { context: MODEL_MAX_TOKENS },
          tool_call: true,
        },
      },
    },
  };

  const originalJazzHome = process.env["JAZZ_HOME"];
  const originalOffline = process.env["JAZZ_OFFLINE"];

  // Offline is forced here rather than inherited: the client fetches models.dev first
  // and only falls back to the snapshot when the fetch fails, so a runner with network
  // would resolve the real catalog — which carries no ollama provider at all.
  function seedCatalog(catalog: unknown): void {
    const jazzHome = process.env["JAZZ_HOME"];
    if (jazzHome === undefined) throw new Error("JAZZ_HOME is not set for this test");
    writeFileSync(join(jazzHome, "cache", "models-dev.json"), JSON.stringify(catalog));
    clearModelsDevCache();
  }

  beforeEach(() => {
    const jazzHome = mkdtempSync(join(tmpdir(), "jazz-agent-loop-test-"));
    mkdirSync(join(jazzHome, "cache"), { recursive: true });
    process.env["JAZZ_HOME"] = jazzHome;
    process.env["JAZZ_OFFLINE"] = "1";
    seedCatalog(modelsDevCatalog);
  });

  afterEach(() => {
    clearModelsDevCache();
    if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = originalJazzHome;
    if (originalOffline === undefined) delete process.env["JAZZ_OFFLINE"];
    else process.env["JAZZ_OFFLINE"] = originalOffline;
  });

  // ~500k characters ≈ 143k tokens at qwen's 3.5 chars/token: over 80% of the pinned
  // 131072 window, comfortably under 80% of the advertised 262144 one.
  function longHistory(): { role: "user" | "assistant"; content: string }[] {
    return [
      { role: "user" as const, content: "system" },
      ...Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        content: `turn ${index} `.padEnd(12500, "x"),
      })),
    ];
  }

  function ollamaAgent(numCtx?: number): unknown {
    return {
      id: "agent-1",
      name: "local-agent",
      config: {
        persona: "default",
        llmModel: "qwen3.6:27b",
        llmProvider: "ollama",
        reasoningEffort: "medium",
        ...(numCtx !== undefined && { numCtx }),
      },
    };
  }

  function runWithHistory(numCtx?: number): Promise<{ compactions: number }> {
    let compactions = 0;
    const countingRunRecursive: RecursiveRunner = () =>
      Effect.sync(() => {
        compactions++;
        return { content: "summary of earlier turns", conversationId: "id" } as AgentResponse;
      });

    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "qwen3.6:27b", content: "done" },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    return Effect.runPromise(
      executeAgentLoop(
        makeOptions({ agent: ollamaAgent(numCtx) as AgentRunnerOptions["agent"] }),
        makeRunContext({
          provider: "ollama",
          model: "qwen3.6:27b",
          agent: ollamaAgent(numCtx) as AgentRunContext["agent"],
          messages: longHistory() as AgentRunContext["messages"],
        }),
        displayConfig,
        strategy,
        defaultObserver,
        countingRunRecursive,
      ).pipe(Effect.provide(TestLayer)),
    ).then(() => ({ compactions }));
  }

  it("compacts against the pinned num_ctx rather than the advertised model maximum", async () => {
    const { compactions } = await runWithHistory(PINNED_CONTEXT_WINDOW);
    expect(compactions).toBeGreaterThan(0);
  });

  it("does not compact a history that genuinely fits the window", async () => {
    const { compactions } = await runWithHistory(MODEL_MAX_TOKENS);
    expect(compactions).toBe(0);
  });

  // models.dev carries no ollama provider, so every ollama model resolves to the
  // unknown-model placeholder (128k). Treating that as a ceiling would silently shrink
  // a window the user pinned and the server was configured to serve.
  it("honours a pinned window larger than the placeholder when nothing knows the model", async () => {
    seedCatalog({});

    const { compactions } = await runWithHistory(200000);
    expect(compactions).toBe(0);
  });

  it("tells the user when a local agent pins no window", async () => {
    const { observer, calls } = recordingObserver();
    const strategy: CompletionStrategy = {
      shouldShowThinking: false,
      getCompletion: () =>
        Effect.succeed({
          completion: { id: "c1", model: "qwen3.6:27b", content: "done" },
          interrupted: false,
        }),
      presentResponse: () => Effect.void,
      onComplete: () => Effect.void,
      getRenderer: () => null,
    };

    await Effect.runPromise(
      executeAgentLoop(
        makeOptions({ agent: ollamaAgent() as AgentRunnerOptions["agent"] }),
        makeRunContext({
          provider: "ollama",
          model: "qwen3.6:27b",
          agent: ollamaAgent() as AgentRunContext["agent"],
        }),
        displayConfig,
        strategy,
        observer,
        runRecursive,
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(calls).toContain("context-window-unknown:local-agent");
  });
});
