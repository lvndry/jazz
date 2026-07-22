import { FileSystem } from "@effect/platform";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { OneShotPresentationService } from "@/core/presentation/oneshot-presentation-service";
import { SkillServiceTag } from "@/core/skills/skill-service";
import { executeWithoutStreaming } from "./batch-executor";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import type { LLMService } from "../../interfaces/llm";
import { LLMServiceTag } from "../../interfaces/llm";
import { LoggerServiceTag } from "../../interfaces/logger";
import { MCPServerManagerTag } from "../../interfaces/mcp-server";
import { PresentationServiceTag } from "../../interfaces/presentation";
import { TerminalServiceTag } from "../../interfaces/terminal";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { ChatCompletionResponse } from "../../types/chat";
import type { StreamEvent } from "../../types/streaming";
import type { RecursiveRunner } from "../context/summarizer";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { DEFAULT_DISPLAY_CONFIG } from "../types";
import type { AgentRunContext, AgentRunnerOptions, AgentResponse } from "../types";

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

function makeLLMService(): LLMService {
  let call = 0;
  return {
    createStreamingChatCompletion: () => Effect.fail(new Error("streaming must not be used")),
    createChatCompletion: () =>
      Effect.sync(() => {
        call += 1;
        return call === 1 ? toolCallCompletion : finalCompletion;
      }),
    listProviders: () => Effect.succeed([]),
    getProvider: () => Effect.fail(new Error("not implemented")),
    supportsNativeWebSearch: () => Effect.succeed(false),
  } as unknown as LLMService;
}

function makeOptions(): AgentRunnerOptions {
  return {
    sessionId: "test-session",
    agent: {
      id: "agent-1",
      name: "test-agent",
      config: {
        persona: "default",
        llmModel: "qwen3-coder",
        llmProvider: "ollama",
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
      llmModel: "qwen3-coder",
      llmProvider: "ollama",
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
    knownSkills: [],
    maxRetries: 0,
  };
}

const runRecursive: RecursiveRunner = () =>
  Effect.succeed({ content: "recursive", conversationId: "id" } as AgentResponse);

function buildLayer(presentationService: OneShotPresentationService) {
  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(PresentationServiceTag, presentationService as any),
    Layer.succeed(LLMServiceTag, makeLLMService()),
    Layer.succeed(ToolRegistryTag, mockToolRegistry),
    Layer.succeed(MCPServerManagerTag, {} as any),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    Layer.succeed(FileSystem.FileSystem, {} as any),
    Layer.succeed(TerminalServiceTag, {} as any),
    Layer.succeed(FileSystemContextServiceTag, {} as any),
    Layer.succeed(SkillServiceTag, mockSkillService),
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
      if (trimmed.length === 0) continue;
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
      | Extract<StreamEvent, { type: "tool_execution_start" }>
      | undefined;
    expect(startEvent?.toolName).toBe("ls");
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
});
