import { FileSystem } from "@effect/platform";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { ToolExecutor } from "./tool-executor";
import { type SkillService, SkillServiceTag } from "../../../core/skills/skill-service";
import type { AgentConfigService } from "../../interfaces/agent-config";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import type { FileSystemContextService } from "../../interfaces/fs";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import type { LoggerService } from "../../interfaces/logger";
import { LoggerServiceTag } from "../../interfaces/logger";
import type { MCPServerManager } from "../../interfaces/mcp-server";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import type { PresentationService } from "../../interfaces/presentation";
import { PresentationServiceTag } from "../../interfaces/presentation";
import type { TerminalService } from "../../interfaces/terminal";
import { TerminalServiceTag } from "../../interfaces/terminal";
import type { ToolRegistry } from "../../interfaces/tool-registry";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { ToolCall, ToolExecutionResult } from "../../types/tools";
import type { createAgentRunMetrics } from "../metrics/agent-run-metrics";

/** Result shape of executeToolCall / executeToolCalls items */
type ToolCallExecutionResult = {
  toolCallId: string;
  result: unknown;
  success: boolean;
  name: string;
};

const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setSessionId: () => Effect.void,
  clearSessionId: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
} as LoggerService;

const mockPresentationService = {
  formatToolsDetected: () => Effect.succeed("Tools detected"),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  formatToolExecutionStart: () => Effect.succeed("Starting tool"),
  formatToolExecutionComplete: () => Effect.succeed("Tool completed"),
  formatToolResult: () => "Tool result",
  formatToolExecutionError: () => Effect.succeed("Tool failed"),
  signalToolExecutionStarted: () => Effect.void,
  requestApproval: () => Effect.succeed({ approved: true }),
} as unknown as PresentationService;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as AgentConfigService;

const mockSkillService = {
  listSkills: () => Effect.succeed([]),
  loadSkill: () => Effect.fail(new Error("not implemented")),
  loadSkillSection: () => Effect.fail(new Error("not implemented")),
} as SkillService;

// Minimal stubs for services not exercised in these tests
const emptyFs = {} as unknown as FileSystem.FileSystem;
const emptyTerminal = {} as unknown as TerminalService;
const emptyFsContext = {} as unknown as FileSystemContextService;
const emptyLlm = {} as unknown as LLMService;
const emptyMcp = {} as unknown as MCPServerManager;

function makeRunMetrics(): ReturnType<typeof createAgentRunMetrics> {
  return {
    runId: "test-run",
    agentId: "agent-1",
    agentName: "test-agent",
    persona: "default",
    agentUpdatedAt: new Date(),
    conversationId: "conv-123",
    maxIterations: 10,
    startedAt: new Date(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    llmRetryCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolsUsed: new Set(),
    toolCallCounts: {},
    toolInvocationSequence: [],
    errors: [],
    iterationSummaries: [],
    currentIteration: undefined,
    firstTokenLatencyMs: undefined,
  };
}

const displayConfig = { showThinking: false, showToolExecution: true, mode: "markdown" as const };

describe("ToolExecutor.executeTool", () => {
  it("should execute a tool successfully", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "test_tool",
          timeoutMs: 5000,
          approvalExecuteToolName: undefined,
        }),
      executeTool: () => Effect.succeed({ success: true, result: { data: "ok" } }),
    } as unknown as ToolRegistry;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
    );

    const result = await Effect.runPromise(
      ToolExecutor.executeTool(
        "test_tool",
        { key: "value" },
        {
          agentId: "agent-1",
          conversationId: "conv-123",
          sessionId: "sess-1",
        },
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, unknown, never>,
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ data: "ok" });
  });

  it("should handle tool not found gracefully in timeout lookup", async () => {
    const mockToolRegistry = {
      getTool: () => Effect.fail(new Error("Tool not found")),
      executeTool: () => Effect.succeed({ success: true, result: "ok" }),
    } as unknown as ToolRegistry;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
    );

    // executeTool still works even if getTool fails for timeout lookup
    const result = await Effect.runPromise(
      ToolExecutor.executeTool(
        "test_tool",
        {},
        {
          agentId: "agent-1",
          conversationId: "conv-123",
          sessionId: "sess-1",
        },
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, unknown, never>,
    );

    expect(result.success).toBe(true);
  });
});

describe("ToolExecutor.executeToolCall", () => {
  it("should handle invalid JSON arguments", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "test_tool",
          timeoutMs: 5000,
          longRunning: false,
          approvalExecuteToolName: undefined,
        }),
      executeTool: () => Effect.succeed({ success: true, result: "ok" }),
    } as unknown as ToolRegistry;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
    );

    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "test_tool", arguments: "not-valid-json" },
    };

    const result = await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        { agentId: "agent-1", conversationId: "conv-123", sessionId: "sess-1" },
        displayConfig,
        null,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        new Set(),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolCallExecutionResult, unknown, never>,
    );

    expect(result.success).toBe(false);
    expect(result.result).toHaveProperty("error");
  });

  it("should skip non-function tool calls", async () => {
    const emptyRegistry = {} as unknown as ToolRegistry;
    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, emptyRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
    );

    const toolCall = {
      id: "call_1",
      type: "not_function",
      function: { name: "test_tool", arguments: "{}" },
    } as unknown as ToolCall;

    const result = await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        { agentId: "agent-1", conversationId: "conv-123", sessionId: "sess-1" },
        displayConfig,
        null,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        new Set(),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolCallExecutionResult, unknown, never>,
    );

    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
  });
});

describe("ToolExecutor.executeToolCalls", () => {
  it("should execute multiple tool calls", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "test_tool",
          timeoutMs: 5000,
          longRunning: false,
          approvalExecuteToolName: undefined,
        }),
      executeTool: (_name: string) => Effect.succeed({ success: true, result: { data: "ok" } }),
    } as unknown as ToolRegistry;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
    );

    const toolCalls: ToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "tool_a", arguments: '{"arg1":"val1"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "tool_b", arguments: '{"arg2":"val2"}' },
      },
    ];

    const results = await Effect.runPromise(
      ToolExecutor.executeToolCalls(
        toolCalls,
        { agentId: "agent-1", conversationId: "conv-123", sessionId: "sess-1" },
        { showThinking: false, showToolExecution: false, mode: "markdown" as const },
        null,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        "test-agent",
      ).pipe(Effect.provide(testLayer)) as unknown as Effect.Effect<
        readonly ToolCallExecutionResult[],
        unknown,
        never
      >,
    );

    expect(results).toHaveLength(2);
    expect(results[0].toolCallId).toBe("call_1");
    expect(results[1].toolCallId).toBe("call_2");
  });
});
