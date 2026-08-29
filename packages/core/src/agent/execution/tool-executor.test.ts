import { FileSystem } from "@effect/platform";
import { describe, expect, it } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { ToolExecutor } from "./tool-executor";
import type { AgentConfigService } from "../../interfaces/agent-config";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import type { FileSystemContextService } from "../../interfaces/fs";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import { JobQueueServiceTag } from "../../interfaces/job-queue-service";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import type { LoggerService } from "../../interfaces/logger";
import { LoggerServiceTag } from "../../interfaces/logger";
import type { MCPServerManager } from "../../interfaces/mcp-server";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { type MemoryService, MemoryServiceTag } from "../../interfaces/memory-service";
import { PeerLedgerServiceTag, PeerTokenServiceTag } from "../../interfaces/peers";
import type { PresentationService, StreamingRenderer } from "../../interfaces/presentation";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { type ReminderService, ReminderServiceTag } from "../../interfaces/reminder-service";
import type { TerminalService } from "../../interfaces/terminal";
import { TerminalServiceTag } from "../../interfaces/terminal";
import type { ToolRegistry } from "../../interfaces/tool-registry";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import { WakeTriggerServiceTag } from "../../interfaces/wake-trigger-service";
import { WorkspaceServiceTag } from "../../interfaces/workspace-service";
import { type SkillService, SkillServiceTag } from "../../skills/skill-service";
import { GenerationInterruptedError } from "../../types/errors";
import type { DisplayConfig } from "../../types/output";
import type { StreamEvent } from "../../types/streaming";
import type { ApprovalRequest, ToolCall, ToolExecutionResult } from "../../types/tools";
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
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
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
} as unknown as SkillService;

// Minimal stubs for services not exercised in these tests
const emptyFs = {} as unknown as FileSystem.FileSystem;
const emptyTerminal = {} as unknown as TerminalService;
const emptyFsContext = {} as unknown as FileSystemContextService;
const emptyLlm = {} as unknown as LLMService;
const emptyMcp = {} as unknown as MCPServerManager;
// Required by the tool pipeline's type but never reached by these tests; provided
// so the requirement is genuinely discharged rather than cast away.
const emptyMemory = {} as unknown as MemoryService;
const emptyReminders = {} as unknown as ReminderService;

function makeRunMetrics(): ReturnType<typeof createAgentRunMetrics> {
  return {
    runId: "test-run",
    agentId: "agent-1",
    agentName: "test-agent",
    persona: "default",
    agentUpdatedAt: new Date(),
    conversationId: "conv-123",
    maxIterations: 10,
    maxCostUSD: undefined,
    startedAt: new Date(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    childCostUSD: 0,
    childCostUnknown: false,
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
    totalToolDefinitionTokens: 0,
    totalToolResultTokens: 0,
    toolDefinitionsOffered: 0,
    classifierPromptTokens: 0,
    classifierCompletionTokens: 0,
    classifierRequests: 0,
    classifierDurationMs: 0,
  };
}

const displayConfig: DisplayConfig = {
  showReasoning: false,
  showToolExecution: true,
  mode: "hybrid",
};

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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const result = await Effect.runPromise(
      ToolExecutor.executeTool(
        "test_tool",
        { key: "value" },
        {
          agentId: "agent-1",
          conversationId: "sess-1",
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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    // executeTool still works even if getTool fails for timeout lookup
    const result = await Effect.runPromise(
      ToolExecutor.executeTool(
        "test_tool",
        {},
        {
          agentId: "agent-1",
          conversationId: "sess-1",
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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "test_tool", arguments: "not-valid-json" },
    };

    const result = await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        { agentId: "agent-1", conversationId: "sess-1" },
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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCall = {
      id: "call_1",
      type: "not_function",
      function: { name: "test_tool", arguments: "{}" },
    } as unknown as ToolCall;

    const result = await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        { agentId: "agent-1", conversationId: "sess-1" },
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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
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
        { agentId: "agent-1", conversationId: "sess-1" },
        { showReasoning: false, showToolExecution: false, mode: "hybrid" as const },
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
    expect(results[0]?.toolCallId).toBe("call_1");
    expect(results[1]?.toolCallId).toBe("call_2");
  });

  it("emits cancelled completes and fails when the interrupt signal fires", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "slow_tool",
          timeoutMs: 60_000,
          longRunning: false,
          approvalExecuteToolName: undefined,
        }),
      executeTool: () => Effect.never,
    } as unknown as ToolRegistry;

    const emittedEvents: StreamEvent[] = [];
    const recordingRenderer: StreamingRenderer = {
      handleEvent: (event) =>
        Effect.sync(() => {
          emittedEvents.push(event);
        }),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCalls: ToolCall[] = [
      {
        id: "call_slow",
        type: "function",
        function: { name: "slow_tool", arguments: "{}" },
      },
    ];

    const program = Effect.gen(function* () {
      const interruptDeferred = yield* Deferred.make<void>();
      const fiber = yield* Effect.fork(
        ToolExecutor.executeToolCalls(
          toolCalls,
          { agentId: "agent-1", conversationId: "sess-1" },
          { showReasoning: false, showToolExecution: true, mode: "hybrid" as const },
          recordingRenderer,
          makeRunMetrics(),
          "agent-1",
          "conv-123",
          "test-agent",
          Deferred.await(interruptDeferred),
        ),
      );
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(interruptDeferred, undefined);
      return yield* Fiber.await(fiber);
    });

    const exit = await Effect.runPromise(
      program.pipe(Effect.provide(testLayer)) as Effect.Effect<
        Exit.Exit<
          readonly { toolCallId: string; result: unknown; success: boolean; name: string }[],
          unknown
        >,
        unknown,
        never
      >,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(GenerationInterruptedError);
      }
    }
    expect(
      emittedEvents.some(
        (event) =>
          event.type === "tool_execution_complete" &&
          event.toolCallId === "call_slow" &&
          event.success === false,
      ),
    ).toBe(true);
  });

  it("detaches an in-flight tool call when the background signal fires, instead of killing it", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "background_tool",
          timeoutMs: 60_000,
          longRunning: false,
          approvalExecuteToolName: undefined,
        }),
      executeTool: () =>
        Effect.sleep("80 millis").pipe(
          Effect.as({ success: true, result: { data: "real result" } }),
        ),
    } as unknown as ToolRegistry;

    const emittedEvents: StreamEvent[] = [];
    const recordingRenderer: StreamingRenderer = {
      handleEvent: (event) =>
        Effect.sync(() => {
          emittedEvents.push(event);
        }),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

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
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCalls: ToolCall[] = [
      {
        id: "call_bg",
        type: "function",
        function: { name: "background_tool", arguments: "{}" },
      },
    ];

    const program = Effect.gen(function* () {
      const backgroundDeferred = yield* Deferred.make<void>();
      const completions: string[] = [];

      const fiber = yield* Effect.fork(
        ToolExecutor.executeToolCalls(
          toolCalls,
          { agentId: "agent-1", conversationId: "sess-1" },
          { showReasoning: false, showToolExecution: true, mode: "hybrid" as const },
          recordingRenderer,
          makeRunMetrics(),
          "agent-1",
          "conv-123",
          "test-agent",
          undefined,
          Deferred.await(backgroundDeferred),
          (summary: string) => {
            completions.push(summary);
          },
        ),
      );

      // Fire the background signal while `background_tool` is still mid-sleep.
      yield* Effect.sleep("10 millis");
      yield* Deferred.succeed(backgroundDeferred, undefined);

      const immediateResults = yield* Fiber.join(fiber);

      // Give the detached fiber time to actually finish and report back.
      yield* Effect.sleep("150 millis");

      return { immediateResults, completions };
    });

    const { immediateResults, completions } = await Effect.runPromise(
      program.pipe(Effect.provide(testLayer)) as Effect.Effect<
        {
          immediateResults: readonly {
            toolCallId: string;
            result: unknown;
            success: boolean;
            name: string;
          }[];
          completions: readonly string[];
        },
        unknown,
        never
      >,
    );

    // The turn continues immediately with a placeholder, not the real (not-yet-ready) result.
    expect(immediateResults).toHaveLength(1);
    expect(immediateResults[0]?.success).toBe(true);
    expect(immediateResults[0]?.result).toMatchObject({ backgrounded: true });

    // The tool itself was never interrupted — the detached fiber ran to completion and
    // reported its real result back through onDetachedToolComplete.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toContain("real result");
    expect(
      emittedEvents.some(
        (event) =>
          event.type === "tool_execution_complete" &&
          event.toolCallId === "call_bg" &&
          event.success === true,
      ),
    ).toBe(true);
  });
});

describe("ToolExecutor.executeToolCall approval events", () => {
  it("emits approval_required/approval_resolved with the tool call's id, message, and previewDiff", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "approval_tool",
          timeoutMs: 5000,
          longRunning: false,
          approvalExecuteToolName: "real_tool",
          riskLevel: "high-risk" as const,
        }),
      executeTool: (name: string) =>
        name === "approval_tool"
          ? Effect.succeed({
              success: true,
              result: {
                approvalRequired: true,
                message: "About to run a risky command",
                executeToolName: "real_tool",
                executeArgs: { command: "echo hi" },
                previewDiff: "- old\n+ new",
              },
            })
          : Effect.succeed({ success: true, result: { data: "executed" } }),
    } as unknown as ToolRegistry;

    const receivedRequests: ApprovalRequest[] = [];
    const approvingPresentationService = {
      ...mockPresentationService,
      requestApproval: (request: ApprovalRequest) => {
        receivedRequests.push(request);
        return Effect.succeed({ approved: true } as const);
      },
    } as unknown as PresentationService;

    const emittedEvents: StreamEvent[] = [];
    const recordingRenderer: StreamingRenderer = {
      handleEvent: (event) =>
        Effect.sync(() => {
          emittedEvents.push(event);
        }),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, approvingPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCall: ToolCall = {
      id: "call_approval_1",
      type: "function",
      function: { name: "approval_tool", arguments: "{}" },
    };

    await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        { agentId: "agent-1", conversationId: "sess-1" },
        displayConfig,
        recordingRenderer,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        new Set(["approval_tool"]),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolCallExecutionResult, unknown, never>,
    );

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]?.toolCallId).toBe("call_approval_1");
    expect(receivedRequests[0]?.message).toBe("About to run a risky command");
    expect(receivedRequests[0]?.previewDiff).toBe("- old\n+ new");

    const approvalRequired = emittedEvents.find((event) => event.type === "approval_required") as
      Extract<StreamEvent, { type: "approval_required" }> | undefined;
    expect(approvalRequired?.toolCallId).toBe("call_approval_1");
    expect(approvalRequired?.message).toBe("About to run a risky command");
    expect(approvalRequired?.previewDiff).toBe("- old\n+ new");

    const approvalResolved = emittedEvents.find((event) => event.type === "approval_resolved") as
      Extract<StreamEvent, { type: "approval_resolved" }> | undefined;
    expect(approvalResolved?.toolCallId).toBe("call_approval_1");
    expect(approvalResolved?.approved).toBe(true);
  });

  it("emits classifying/classified events and the verdict on complete for execute_command", async () => {
    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "execute_command",
          timeoutMs: 5000,
          longRunning: false,
          approvalExecuteToolName: "execute_execute_command",
          riskLevel: "unknown" as const,
        }),
      executeTool: (name: string) =>
        name === "execute_command"
          ? Effect.succeed({
              success: true,
              result: {
                approvalRequired: true,
                message: "Run python3 --version",
                executeToolName: "execute_execute_command",
                executeArgs: { command: "python3 --version" },
              },
            })
          : Effect.succeed({
              success: true,
              result: { stdout: "Python 3.14.5", exitCode: 0 },
            }),
    } as unknown as ToolRegistry;

    const emittedEvents: StreamEvent[] = [];
    const recordingRenderer: StreamingRenderer = {
      handleEvent: (event) =>
        Effect.sync(() => {
          emittedEvents.push(event);
        }),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

    const promptingPresentation = {
      ...mockPresentationService,
      canPromptForApproval: () => true,
      requestApproval: () => {
        throw new Error("classifier should have auto-approved");
      },
    } as unknown as PresentationService;

    const classifyingLlm = {
      createChatCompletion: () =>
        Effect.succeed({ id: "1", model: "gpt-4o-mini", content: "read-only" }),
    } as unknown as LLMService;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, promptingPresentation),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, classifyingLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    const toolCall: ToolCall = {
      id: "call_cmd_1",
      type: "function",
      function: { name: "execute_command", arguments: '{"command":"python3 --version"}' },
    };

    await Effect.runPromise(
      ToolExecutor.executeToolCall(
        toolCall,
        {
          agentId: "agent-1",
          conversationId: "sess-1",
          parentAgent: {
            id: "agent-1",
            name: "test",
            config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4o-mini" },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        displayConfig,
        recordingRenderer,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        new Set(["execute_command"]),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolCallExecutionResult, unknown, never>,
    );

    const types = emittedEvents.map((event) => event.type);
    expect(types).toContain("command_risk_classifying");
    expect(types).toContain("command_risk_classified");

    const classified = emittedEvents.find((event) => event.type === "command_risk_classified") as
      Extract<StreamEvent, { type: "command_risk_classified" }> | undefined;
    expect(classified?.riskLevel).toBe("read-only");
    expect(classified?.autoApproved).toBe(true);
    expect(classified?.command).toBe("python3 --version");

    const complete = emittedEvents.find((event) => event.type === "tool_execution_complete") as
      Extract<StreamEvent, { type: "tool_execution_complete" }> | undefined;
    expect(complete?.classifiedRisk).toBe("read-only");
    expect(complete?.success).toBe(true);
  });
});

describe("ToolExecutor picker-style approvals", () => {
  function buildPickerHarness(outcome: { approved: true; selectedOptionId: string }) {
    const executeArgsSeen: Record<string, unknown>[] = [];
    const receivedRequests: ApprovalRequest[] = [];

    const mockToolRegistry = {
      getTool: () =>
        Effect.succeed({
          name: "analyze_media",
          timeoutMs: 5000,
          longRunning: false,
          approvalExecuteToolName: "execute_analyze_media",
          riskLevel: "high-risk" as const,
        }),
      executeTool: (name: string, args: Record<string, unknown>) => {
        if (name === "analyze_media") {
          return Effect.succeed({
            success: true,
            result: {
              approvalRequired: true,
              message: "Delegate vision analysis to a capable model.",
              executeToolName: "execute_analyze_media",
              executeArgs: { capability: "vision", task: "describe", mediaPaths: ["/tmp/a.png"] },
              options: [
                {
                  id: "anthropic/claude-sonnet-4-5",
                  label: "Claude Sonnet 4.5",
                  detail: "$3/M in",
                },
                { id: "openai/gpt-5", label: "GPT-5", detail: "price unknown" },
              ],
            },
          });
        }
        executeArgsSeen.push(args);
        return Effect.succeed({ success: true, result: { answer: "a cat on a mat" } });
      },
    } as unknown as ToolRegistry;

    const presentationService = {
      ...mockPresentationService,
      requestApproval: (request: ApprovalRequest) => {
        receivedRequests.push(request);
        return Effect.succeed(outcome);
      },
    } as unknown as PresentationService;

    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, presentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(FileSystem.FileSystem, emptyFs),
      Layer.succeed(TerminalServiceTag, emptyTerminal),
      Layer.succeed(FileSystemContextServiceTag, emptyFsContext),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(LLMServiceTag, emptyLlm),
      Layer.succeed(MCPServerManagerTag, emptyMcp),
      Layer.succeed(MemoryServiceTag, emptyMemory),
      Layer.succeed(WorkspaceServiceTag, {} as any),
      Layer.succeed(WakeTriggerServiceTag, {} as any),
      Layer.succeed(JobQueueServiceTag, {} as any),
      Layer.succeed(ReminderServiceTag, emptyReminders),
      Layer.succeed(PeerLedgerServiceTag, {} as any),
      Layer.succeed(PeerTokenServiceTag, {} as any),
    );

    return { testLayer, executeArgsSeen, receivedRequests };
  }

  it("asks the human even under a yolo policy, and merges the picked row into the execution args", async () => {
    const { testLayer, executeArgsSeen, receivedRequests } = buildPickerHarness({
      approved: true,
      selectedOptionId: "anthropic/claude-sonnet-4-5",
    });

    await Effect.runPromise(
      ToolExecutor.executeToolCall(
        {
          id: "call_picker_1",
          type: "function",
          function: { name: "analyze_media", arguments: "{}" },
        },
        // Yolo: every other high-risk tool would sail through. A picker must not.
        {
          agentId: "agent-1",
          getAutoApprovePolicy: () => true,
        },
        displayConfig,
        null,
        makeRunMetrics(),
        "agent-1",
        "conv-123",
        new Set(["analyze_media"]),
      ).pipe(Effect.provide(testLayer)) as Effect.Effect<ToolCallExecutionResult, unknown, never>,
    );

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]?.options).toHaveLength(2);

    expect(executeArgsSeen).toHaveLength(1);
    const seen = executeArgsSeen[0] as Record<string, unknown> | undefined;
    expect(seen?.["_selectedOptionId"]).toBe("anthropic/claude-sonnet-4-5");
  });
});
