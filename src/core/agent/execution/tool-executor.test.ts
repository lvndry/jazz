import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { ToolExecutor } from "./tool-executor";
import { SkillServiceTag } from "../../../core/skills/skill-service";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { CalendarServiceTag } from "../../interfaces/calendar";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import { GmailServiceTag } from "../../interfaces/gmail";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { createAgentRunMetrics } from "../metrics/agent-run-metrics";

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
  formatToolsDetected: () => Effect.succeed("Tools detected"),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  formatToolExecutionStart: () => Effect.succeed("Starting tool"),
  formatToolExecutionComplete: () => Effect.succeed("Tool completed"),
  formatToolResult: () => "Tool result",
  formatToolExecutionError: () => Effect.succeed("Tool failed"),
  signalToolExecutionStarted: () => Effect.void,
  requestApproval: () => Effect.succeed({ approved: true }),
} as any;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as any;

const mockSkillService = {
  listSkills: () => Effect.succeed([]),
  loadSkill: () => Effect.fail(new Error("not implemented")),
  loadSkillSection: () => Effect.fail(new Error("not implemented")),
} as any;

function makeRunMetrics(): ReturnType<typeof createAgentRunMetrics> {
  return {
    runId: "test-run",
    agentId: "agent-1",
    agentName: "test-agent",
    agentType: "default",
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
    } as any;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(GmailServiceTag, {} as any),
      Layer.succeed(CalendarServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, {} as any),
      Layer.succeed(MCPServerManagerTag, {} as any),
    );

    const result = await Effect.runPromise(
      ToolExecutor.executeTool("test_tool", { key: "value" }, {
        agentId: "agent-1",
        conversationId: "conv-123",
        sessionId: "sess-1",
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ data: "ok" });
  });

  it("should handle tool not found gracefully in timeout lookup", async () => {
    const mockToolRegistry = {
      getTool: () => Effect.fail(new Error("Tool not found")),
      executeTool: () => Effect.succeed({ success: true, result: "ok" }),
    } as any;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(GmailServiceTag, {} as any),
      Layer.succeed(CalendarServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, {} as any),
      Layer.succeed(MCPServerManagerTag, {} as any),
    );

    // executeTool still works even if getTool fails for timeout lookup
    const result = await Effect.runPromise(
      ToolExecutor.executeTool("test_tool", {}, {
        agentId: "agent-1",
        conversationId: "conv-123",
        sessionId: "sess-1",
      }).pipe(Effect.provide(testLayer)),
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
    } as any;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(GmailServiceTag, {} as any),
      Layer.succeed(CalendarServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, {} as any),
      Layer.succeed(MCPServerManagerTag, {} as any),
    );

    const toolCall = {
      id: "call_1",
      type: "function" as const,
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
      ).pipe(Effect.provide(testLayer)),
    );

    expect(result.success).toBe(false);
    expect(result.result).toHaveProperty("error");
  });

  it("should skip non-function tool calls", async () => {
    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, {} as any),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(GmailServiceTag, {} as any),
      Layer.succeed(CalendarServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, {} as any),
      Layer.succeed(MCPServerManagerTag, {} as any),
    );

    const toolCall = {
      id: "call_1",
      type: "not_function" as any,
      function: { name: "test_tool", arguments: "{}" },
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
      ).pipe(Effect.provide(testLayer)),
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
      executeTool: (_name: string) =>
        Effect.succeed({ success: true, result: { data: "ok" } }),
    } as any;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as any),
      Layer.succeed(TerminalServiceTag, {} as any),
      Layer.succeed(GmailServiceTag, {} as any),
      Layer.succeed(CalendarServiceTag, {} as any),
      Layer.succeed(FileSystemContextServiceTag, {} as any),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, {} as any),
      Layer.succeed(MCPServerManagerTag, {} as any),
    );

    const toolCalls = [
      {
        id: "call_1",
        type: "function" as const,
        function: { name: "tool_a", arguments: '{"arg1":"val1"}' },
      },
      {
        id: "call_2",
        type: "function" as const,
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
      ).pipe(Effect.provide(testLayer)),
    );

    expect(results).toHaveLength(2);
    expect(results[0].toolCallId).toBe("call_1");
    expect(results[1].toolCallId).toBe("call_2");
  });
});
