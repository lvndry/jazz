import { afterEach, describe, expect, it } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { OneShotPresentationService } from "@/core/presentation/oneshot-presentation-service";
import { SkillServiceTag } from "@/core/skills/skill-service";
import { executeWithoutStreaming } from "./batch-executor";
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
import { OccupancyServiceTag } from "../../interfaces/occupancy";
import { PeerLedgerServiceTag, PeerTokenServiceTag } from "../../interfaces/peers";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { ReminderServiceTag } from "../../interfaces/reminder-service";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import { WakeTriggerServiceTag } from "../../interfaces/wake-trigger-service";
import { WorkspaceServiceTag } from "../../interfaces/workspace-service";
import type { ChatCompletionResponse } from "../../types/chat";
import type { StreamEvent } from "../../types/streaming";
import type { RecursiveRunner } from "../context/summarizer";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { createSubagentSupervisor } from "../subagents/supervisor";
import { DEFAULT_DISPLAY_CONFIG } from "../types";
import type { AgentRunContext, AgentRunnerOptions, AgentResponse } from "../types";

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

const mockToolRegistry = {
  getTool: () => Effect.succeed({ approvalExecuteToolName: undefined, timeoutMs: 1000 }),
  listTools: () => Effect.succeed([]),
  listAllTools: () => Effect.succeed(["ls"]),
  getToolDefinitions: () => Effect.succeed([]),
  getToolsInCategory: () => Effect.succeed([]),
  executeTool: () => Effect.succeed({ success: true, result: { entries: ["a", "b"] } }),
} as any;

const mockAgentConfigService = {
  appConfig: Effect.succeed({}),
} as any;

const mockSkillService = {
  listSkills: () => Effect.succeed([]),
} as any;

const toolCallCompletion: ChatCompletionResponse = {
  id: "c1",
  model: "qwen3-coder",
  content: "",
  toolCalls: [
    {
      id: "call_1",
      type: "function" as const,
      function: { name: "ls", arguments: JSON.stringify({ path: "/opt/ultron" }) },
    },
  ],
};

const finalCompletion: ChatCompletionResponse = {
  id: "c2",
  model: "qwen3-coder",
  content: "There are 2 entries.",
};

function makeLLMService(onRequest?: (options: { conversationId?: string }) => void): LLMService {
  let call = 0;
  return {
    createStreamingChatCompletion: () => Effect.fail(new Error("streaming must not be used")),
    createChatCompletion: (_provider: unknown, options: { conversationId?: string }) =>
      Effect.sync(() => {
        onRequest?.(options);
        call += 1;
        return call === 1 ? toolCallCompletion : finalCompletion;
      }),
    listProviders: () => Effect.succeed([]),
    getProvider: () => Effect.fail(new Error("not implemented")),
    supportsNativeWebSearch: () => Effect.succeed(false),
    resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
  } as unknown as LLMService;
}

function makeOptions(): AgentRunnerOptions {
  return {
    conversationId: "test-session",
    agent: {
      id: "agent-1",
      name: "test-agent",
      config: {
        persona: "default",
        llm: { provider: "ollama", model: "qwen3-coder" },
        reasoningEffort: "disable",
      },
    } as any,
    userInput: "list /opt/ultron",
  };
}

function makeRunContext(): AgentRunContext {
  const agent = {
    id: "agent-1",
    name: "test-agent",
    config: {
      persona: "default",
      llm: { provider: "ollama", model: "qwen3-coder" },
      reasoningEffort: "disable",
    },
  } as any;

  return {
    actualConversationId: "conv-123",
    context: { agentId: "agent-1", conversationId: "conv-123" },
    tools: [],
    messages: [{ role: "user", content: "list /opt/ultron" }],
    runMetrics: createAgentRunMetrics({
      agent,
      conversationId: "conv-123",
      provider: "ollama",
      model: "qwen3-coder",
      reasoningEffort: "disable",
    }),
    provider: "ollama",
    model: "qwen3-coder",
    agent,
    expandedToolNames: ["ls"],
    connectedMCPServers: [],
    subagents: Effect.runSync(createSubagentSupervisor()),
    knownSkills: [],
    maxRetries: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxCostUSD: undefined,
    maxTokens: undefined,
    maxOutputTokens: undefined,
    maxDurationMs: undefined,
    deadline: undefined,
  };
}

const runRecursive: RecursiveRunner = () =>
  Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

function buildLayer(
  presentationService: OneShotPresentationService,
  onRequest?: (options: { conversationId?: string }) => void,
  llmService?: LLMService,
) {
  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(PresentationServiceTag, presentationService as any),
    Layer.succeed(LLMServiceTag, llmService ?? makeLLMService(onRequest)),
    Layer.succeed(ToolRegistryTag, mockToolRegistry),
    Layer.succeed(MCPServerManagerTag, {} as any),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    Layer.succeed(FileSystem.FileSystem, {} as any),
    Layer.succeed(TerminalServiceTag, {} as any),
    Layer.succeed(FileSystemContextServiceTag, {} as any),
    Layer.succeed(SkillServiceTag, mockSkillService),
    Layer.succeed(MemoryServiceTag, {} as any),
    Layer.succeed(WorkspaceServiceTag, {} as any),
    Layer.succeed(WakeTriggerServiceTag, {} as any),
    Layer.succeed(JobQueueServiceTag, {} as any),
    Layer.succeed(ReminderServiceTag, {} as any),
    Layer.succeed(GoalStoreTag, {} as any),
    Layer.succeed(PeerLedgerServiceTag, {} as any),
    Layer.succeed(OccupancyServiceTag, {} as any),
    Layer.succeed(PeerTokenServiceTag, {} as any),
  );
}

describe("executeWithoutStreaming tool event emission", () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  function captureStderr(): { lines: string[] } {
    const captured = { lines: [] as string[] };
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return captured;
  }

  function parseEventLines(lines: string[]): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as StreamEvent);
      } catch {
        // Non-JSON stray writes are not part of the contract under test.
      }
    }
    return events;
  }

  it("emits tool lifecycle NDJSON on the non-streaming path when --events tools is active", async () => {
    const presentationService = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>([
        "error",
        "tools_detected",
        "tool_call",
        "tool_execution_start",
        "tool_execution_complete",
      ]),
    );

    const captured = captureStderr();

    await Effect.runPromise(
      executeWithoutStreaming(
        makeOptions(),
        makeRunContext(),
        DEFAULT_DISPLAY_CONFIG,
        false,
        runRecursive,
      ).pipe(Effect.provide(buildLayer(presentationService))),
    );

    const events = parseEventLines(captured.lines);
    const eventTypes = events.map((event) => event.type);

    expect(eventTypes).toContain("tools_detected");
    expect(eventTypes).toContain("tool_execution_start");
    expect(eventTypes).toContain("tool_execution_complete");

    const startEvent = events.find((event) => event.type === "tool_execution_start") as
      Extract<StreamEvent, { type: "tool_execution_start" }> | undefined;
    expect(startEvent?.toolName).toBe("ls");
  });

  it("passes the resolved conversation id to the provider request", async () => {
    const presentationService = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());
    const conversationIds: Array<string | undefined> = [];

    await Effect.runPromise(
      executeWithoutStreaming(
        makeOptions(),
        makeRunContext(),
        DEFAULT_DISPLAY_CONFIG,
        false,
        runRecursive,
      ).pipe(
        Effect.provide(
          buildLayer(presentationService, (options) =>
            conversationIds.push(options.conversationId),
          ),
        ),
      ),
    );

    expect(conversationIds.length).toBeGreaterThan(0);
    expect(new Set(conversationIds)).toEqual(new Set(["conv-123"]));
  });

  it("does not emit tool NDJSON when no event categories are requested", async () => {
    const presentationService = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());

    const captured = captureStderr();

    await Effect.runPromise(
      executeWithoutStreaming(
        makeOptions(),
        makeRunContext(),
        DEFAULT_DISPLAY_CONFIG,
        false,
        runRecursive,
      ).pipe(Effect.provide(buildLayer(presentationService))),
    );

    const events = parseEventLines(captured.lines);
    const toolEventTypes = events
      .map((event) => event.type)
      .filter((type) =>
        ["tools_detected", "tool_execution_start", "tool_execution_complete"].includes(type),
      );

    expect(toolEventTypes).toHaveLength(0);
  });

  it("records batch child tool calls and its answer in the delegated region", async () => {
    class InspectingPresentationService extends OneShotPresentationService {
      readonly events: StreamEvent[] = [];
      readonly answers: Array<{ content: string; regionId: string | undefined }> = [];
      targetRegionId: string | undefined;

      capturesEphemeralRunDetails(): boolean {
        return true;
      }

      override createStreamingRenderer(
        config: Parameters<OneShotPresentationService["createStreamingRenderer"]>[0],
      ) {
        this.targetRegionId =
          config.streamTarget?.kind === "ephemeral" ? config.streamTarget.regionId : undefined;
        return Effect.succeed({
          handleEvent: (event: StreamEvent) =>
            Effect.sync(() => {
              this.events.push(event);
            }),
          setInterruptHandler: () => Effect.void,
          reset: () => Effect.void,
          flush: () => Effect.void,
        });
      }

      override presentAgentResponse(
        _agentName: string,
        content: string,
        options?: { readonly ephemeralRegionId: string },
      ) {
        return Effect.sync(() => {
          this.answers.push({ content, regionId: options?.ephemeralRegionId });
        });
      }
    }

    const presentationService = new InspectingPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set(),
    );
    await Effect.runPromise(
      executeWithoutStreaming(
        { ...makeOptions(), internal: true, ephemeralRegionId: "child-region" },
        makeRunContext(),
        DEFAULT_DISPLAY_CONFIG,
        false,
        runRecursive,
      ).pipe(Effect.provide(buildLayer(presentationService))),
    );

    expect(presentationService.targetRegionId).toBe("child-region");
    expect(presentationService.events.map((event) => event.type)).toContain("tool_execution_start");
    expect(presentationService.events.map((event) => event.type)).toContain(
      "tool_execution_complete",
    );
    expect(presentationService.answers).toEqual([
      { content: "There are 2 entries.", regionId: "child-region" },
    ]);
  });
});

describe("executeWithoutStreaming empty responses", () => {
  const emptyCompletion = (
    overrides: Partial<ChatCompletionResponse> = {},
  ): ChatCompletionResponse => ({
    id: "empty",
    model: "qwen3-coder",
    content: "",
    finishReason: "stop",
    usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
    ...overrides,
  });

  function runWith(
    completions: readonly ChatCompletionResponse[],
    maxRetries: number,
  ): { run: () => Promise<AgentResponse>; calls: () => number; runContext: AgentRunContext } {
    let calls = 0;
    const llmService = {
      ...makeLLMService(),
      createChatCompletion: () =>
        Effect.sync(() => {
          const completion = completions[Math.min(calls, completions.length - 1)]!;
          calls += 1;
          return completion;
        }),
    } as unknown as LLMService;
    const runContext = { ...makeRunContext(), maxRetries };
    const presentationService = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());
    return {
      run: () =>
        Effect.runPromise(
          executeWithoutStreaming(
            makeOptions(),
            runContext,
            DEFAULT_DISPLAY_CONFIG,
            false,
            runRecursive,
          ).pipe(Effect.provide(buildLayer(presentationService, undefined, llmService))),
        ),
      calls: () => calls,
      runContext,
    };
  }

  it("asks again after an empty finish and answers from the retry", async () => {
    const harness = runWith([emptyCompletion(), { ...finalCompletion }], 2);

    const result = await harness.run();

    expect(result.content).toBe("There are 2 entries.");
    expect(harness.calls()).toBe(2);
    expect(harness.runContext.runMetrics.llmRetryCount).toBe(1);
    expect(harness.runContext.runMetrics.totalPromptTokens).toBeGreaterThanOrEqual(12);
  });

  it("fails clearly once the retry budget is spent on empty finishes", async () => {
    const harness = runWith([emptyCompletion()], 1);

    await expect(harness.run()).rejects.toThrow("empty response");
    expect(harness.calls()).toBe(2);
  });

  it("does not retry reasoning-only output", async () => {
    const harness = runWith([emptyCompletion({ reasoning: "thinking it through" })], 2);

    await harness.run();

    expect(harness.calls()).toBe(1);
  });
});
