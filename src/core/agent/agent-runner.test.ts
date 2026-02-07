import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { AgentRunner } from "./agent-runner";
import type { AgentRunnerOptions } from "./types";
import type { AgentConfigService } from "../interfaces/agent-config";
import { AgentConfigServiceTag } from "../interfaces/agent-config";
import type { CalendarService } from "../interfaces/calendar";
import { CalendarServiceTag } from "../interfaces/calendar";
import type { FileSystemContextService } from "../interfaces/fs";
import { FileSystemContextServiceTag } from "../interfaces/fs";
import type { GmailService } from "../interfaces/gmail";
import { GmailServiceTag } from "../interfaces/gmail";
import type { LLMService } from "../interfaces/llm";
import { LLMServiceTag } from "../interfaces/llm";
import type { LoggerService } from "../interfaces/logger";
import { LoggerServiceTag } from "../interfaces/logger";
import type { MCPServerManager } from "../interfaces/mcp-server";
import { MCPServerManagerTag } from "../interfaces/mcp-server";
import type { PresentationService } from "../interfaces/presentation";
import { PresentationServiceTag } from "../interfaces/presentation";
import type { TerminalService } from "../interfaces/terminal";
import { TerminalServiceTag } from "../interfaces/terminal";
import type { ToolRegistry } from "../interfaces/tool-registry";
import { ToolRegistryTag } from "../interfaces/tool-registry";
import type { SkillService } from "../skills/skill-service";
import { SkillServiceTag } from "../skills/skill-service";
import type { Agent } from "../types/agent";

// Mock services
const mockLogger = {
  debug: mock(() => Effect.void),
  info: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  error: mock(() => Effect.void),
  setSessionId: mock(() => Effect.void),
  clearSessionId: mock(() => Effect.void),
  writeToFile: mock(() => Effect.void),
  logToolCall: mock(() => Effect.void),
} as unknown as LoggerService;

const mockPresentationService = {
  presentThinking: mock(() => Effect.void),
  presentThinkingEnd: mock(() => Effect.void),
  createStreamingRenderer: mock(() => Effect.succeed({
    renderEvent: mock(() => Effect.void),
    stop: mock(() => Effect.void),
    handleEvent: mock(() => Effect.void),
    setInterruptHandler: mock(() => Effect.void),
    reset: mock(() => Effect.void),
    flush: mock(() => Effect.void),
  })),
  renderMarkdown: mock((content: string) => Effect.succeed(content)),
  presentAgentResponse: mock(() => Effect.void),
  presentCompletion: mock(() => Effect.void),
  writeOutput: mock(() => Effect.void),
  writeBlankLine: mock(() => Effect.void),
  formatToolExecutionStart: mock(() => Effect.succeed("Tool starting")),
  formatToolExecutionComplete: mock(() => Effect.succeed("Tool completed")),
  formatToolResult: mock(() => "Tool result"),
  formatToolExecutionError: mock(() => Effect.succeed("Tool failed")),
  formatToolsDetected: mock(() => Effect.succeed("Tools detected")),
} as unknown as PresentationService;

const mockTerminalService = {} as unknown as TerminalService;
const mockGmailService = {} as unknown as GmailService;
const mockCalendarService = {} as unknown as CalendarService;
const mockFileSystem = {} as unknown as FileSystem.FileSystem;
const mockFileSystemContext = {} as unknown as FileSystemContextService;

const mockToolRegistry = {
  listTools: mock(() => Effect.succeed(["tool1", "tool2", "load_skill", "load_skill_section"])),
  listAllTools: mock(() => Effect.succeed(["tool1", "tool2", "load_skill", "load_skill_section", "ask_user_question", "ask_file_picker", "spawn_subagent", "summarize_context"])),
  getTool: mock((name: string) => Effect.succeed({
    name,
    approvalExecuteToolName: undefined,
    longRunning: false,
    timeoutMs: undefined,
    function: { name, description: `Description for ${name}` }
  })),
  getToolDefinitions: mock(() => Effect.succeed([
    {
      function: {
        name: "tool1",
        description: "Tool 1 description",
        parameters: {}
      }
    },
    {
      function: {
        name: "tool2",
        description: "Tool 2 description",
        parameters: {}
      }
    }
  ])),
} as unknown as ToolRegistry;

const mockSkillService = {
  listSkills: mock(() => Effect.succeed([
    { name: "skill1", description: "Skill 1" },
    { name: "skill2", description: "Skill 2" }
  ])),
} as unknown as SkillService;

const mockAppConfig = {
  output: {
    showMetrics: true,
    streaming: {
      enabled: true,
      textBufferMs: 100,
    },
    mode: "markdown" as const,
  },
  llm: {
    openai: { api_key: "test-key" },
  },
};

const mockAgentConfigService = {
  appConfig: Effect.succeed(mockAppConfig),
  get: mock(() => Effect.succeed(undefined)),
  getOrElse: mock((_key: string, fallback: unknown) => Effect.succeed(fallback)),
  getOrFail: mock(() => Effect.succeed(undefined)),
  has: mock(() => Effect.succeed(false)),
  set: mock(() => Effect.void),
} as unknown as AgentConfigService;

const mockLlmService = {
  getProvider: mock(() =>
    Effect.succeed({
      name: "openai",
      supportedModels: [{ id: "gpt-4", supportsTools: true }],
      defaultModel: "gpt-4",
      authenticate: () => Effect.void,
    }),
  ),
  listProviders: mock(() => Effect.succeed([])),
  createChatCompletion: mock(() => {
    return Effect.succeed({
      id: "test-completion",
      model: "gpt-4",
      content: "Hello world",
    });
  }),
  createStreamingChatCompletion: mock(() => {
    return Effect.succeed({
      stream: Stream.empty,
      response: Effect.succeed({
        id: "test-completion-stream",
        model: "gpt-4",
        content: "Hello world",
      }),
      cancel: Effect.void,
    });
  }),
  supportsNativeWebSearch: mock(() => Effect.succeed(false)),
} as unknown as LLMService;

const mockMcpServerManager = {
  connectServer: mock(() => Effect.fail(new Error("Not implemented"))),
  disconnectServer: mock(() => Effect.void),
  getServerTools: mock(() => Effect.succeed([])),
  discoverTools: mock(() => Effect.succeed([])),
  resolveTemplateVariables: mock(() => Effect.succeed([])),
  listServers: mock(() => Effect.succeed([])),
  isConnected: mock(() => Effect.succeed(false)),
  disconnectAllServers: mock(() => Effect.void),
} as unknown as MCPServerManager;

describe("AgentRunner", () => {
  function createTestLayer(): Layer.Layer<never, never, unknown> {
    return Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, mockPresentationService),
      Layer.succeed(ToolRegistryTag, mockToolRegistry),
      Layer.succeed(SkillServiceTag, mockSkillService),
      Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
      Layer.succeed(MCPServerManagerTag, mockMcpServerManager),
      Layer.succeed(LLMServiceTag, mockLlmService),
      Layer.succeed(TerminalServiceTag, mockTerminalService),
      Layer.succeed(GmailServiceTag, mockGmailService),
      Layer.succeed(CalendarServiceTag, mockCalendarService),
      Layer.succeed(FileSystem.FileSystem, mockFileSystem),
      Layer.succeed(FileSystemContextServiceTag, mockFileSystemContext)
    );
  }

  function runWithTestLayers<A, E>(
    program: Effect.Effect<A, E, unknown>
  ): Promise<A> {
    return Effect.runPromise(
      program.pipe(Effect.provide(createTestLayer())) as Effect.Effect<A, E, never>,
    );
  }

  const mockAgent: Agent = {
    id: "test-agent-1",
    name: "Test Agent",
    description: "A test agent for unit testing",
    model: "openai/gpt-4",
    config: {
      agentType: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
      tools: ["tool1", "tool2"]
    },
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const defaultOptions: AgentRunnerOptions = {
    agent: mockAgent,
    userInput: "Hello, how can you help me?",
    sessionId: "test-session-123"
  };

  describe("runRecursive", () => {
    it("should force non-streaming for internal runs", async () => {
      const options = {
        ...defaultOptions,
        conversationId: "test-conv-456",
        stream: true,
        maxIterations: 1,
      };

      const result = await runWithTestLayers(
        AgentRunner.runRecursive(options)
      );

      expect(result).toBeDefined();
      expect(result.content).toBe("Hello world");
    });
  });

  describe("run", () => {
    it("should execute agent with streaming when enabled", async () => {
      const options = {
        ...defaultOptions,
        stream: true,
        maxIterations: 1,
      };

      const result = await runWithTestLayers(
        AgentRunner.run(options)
      );

      expect(result).toBeDefined();
      expect(result.content).toBe("Hello world");
      expect(result.conversationId).toBeDefined();
    });
  });
});
