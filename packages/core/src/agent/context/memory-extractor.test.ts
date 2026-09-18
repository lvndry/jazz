import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "../../interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../../interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "../../interfaces/presentation";
import type { Agent, AgentConfig, AppConfig } from "../../types";
import { LLMRequestError } from "../../types/errors";
import type { ChatMessage, ConversationMessages } from "../../types/message";
import { MANAGE_MEMORY_TOOL_NAME, VIEW_MEMORY_TOOL_NAME } from "../memory-recall-log";
import type { AgentResponse } from "../types";
import { extractMemories } from "./memory-extractor";
import { Summarizer, type RecursiveRunner } from "./summarizer";

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  const config: AgentConfig = {
    llmProvider: "openai",
    llmModel: "gpt-4",
    persona: "default",
    tools: [],
  };
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const mockLogger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setLogGroup: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  clearLogGroup: () => Effect.void,
};

const mockAppConfig: AppConfig = {
  storage: { type: "file", path: "/tmp/test" },
  logging: { level: "info", format: "plain" },
};

const mockAgentConfigService: AgentConfigService = {
  appConfig: Effect.succeed(mockAppConfig),
  get: <A>(_key: string) => Effect.succeed(undefined as A),
  getOrElse: <A>(_key: string, fallback: A) => Effect.succeed(fallback),
  getOrFail: <A>(_key: string) => Effect.succeed(undefined as A),
  has: () => Effect.succeed(false),
  set: () => Effect.void,
  revision: Effect.succeed(0),
  secretStorageUnavailable: () => false,
  reloadIfChanged: () => Effect.succeed(false),
};

const mockLLMService: LLMService = {
  getProvider: () =>
    Effect.succeed({
      name: "openai" as const,
      supportedModels: [{ id: "gpt-4", supportsTools: true }],
      defaultModel: "gpt-4",
      authenticate: () => Effect.void,
    }),
  listProviders: () => Effect.succeed([]),
  createChatCompletion: () =>
    Effect.succeed({ id: "mock-completion", model: "gpt-4", content: "" }),
  createStreamingChatCompletion: () =>
    Effect.fail(new LLMRequestError({ provider: "openai", message: "Not implemented in mock" })),
  supportsNativeWebSearch: () => Effect.succeed(false),
  fetchOllamaModelDetails: () => Effect.succeed({}),
  resolveLocalProviderBaseUrl: () => "",
};

const mockPresentationService: PresentationService = {
  presentThinking: () => Effect.void,
  presentCompletion: () => Effect.void,
  presentWarning: () => Effect.void,
  presentAgentResponse: () => Effect.void,
  renderMarkdown: (md) => Effect.succeed(md),
  formatToolArguments: () => "",
  formatToolResult: () => "",
  formatToolExecutionStart: () => Effect.succeed(""),
  formatToolExecutionComplete: () => Effect.succeed(""),
  formatToolExecutionError: () => Effect.succeed(""),
  formatToolsDetected: () => Effect.succeed(""),
  createStreamingRenderer: () =>
    Effect.succeed({
      handleEvent: () => Effect.void,
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    }),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  presentStatus: () => Effect.void,
  openEphemeralRegion: () => Effect.succeed("noop"),
  appendEphemeralRegion: () => Effect.void,
  collapseEphemeralRegion: () => Effect.void,
  requestApproval: () => Effect.succeed({ approved: true }),
  signalToolExecutionStarted: () => Effect.void,
  requestUserInput: () => Effect.succeed({ kind: "unavailable" as const }),
  requestFilePicker: () => Effect.succeed(""),
};

function createTestLayer() {
  return Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(AgentConfigServiceTag, mockAgentConfigService),
    Layer.succeed(LLMServiceTag, mockLLMService),
    Layer.succeed(PresentationServiceTag, mockPresentationService),
  );
}

describe("extractMemories", () => {
  it("runs a memory-extractor sub-agent that carries the parent's memory scopes and memory tools", async () => {
    let capturedAgent: Agent | undefined;
    let capturedMaxIterations: number | undefined;
    const mockRunner: RecursiveRunner = (options) => {
      capturedAgent = options.agent;
      capturedMaxIterations = options.maxIterations;
      return Effect.succeed({ content: "", conversationId: "conv-1" } as AgentResponse);
    };

    const agent = createMockAgent({
      config: {
        llmProvider: "openai",
        llmModel: "gpt-4",
        persona: "default",
        tools: [],
        memoryScopes: ["personal", "work"],
      },
    });
    const messages: ChatMessage[] = [{ role: "user", content: "I prefer tabs over spaces." }];

    await Effect.runPromise(
      extractMemories(messages, agent, "conv-1", mockRunner).pipe(
        Effect.provide(createTestLayer()),
      ) as Effect.Effect<void, never, never>,
    );

    expect(capturedAgent?.id).toBe("memory-extractor");
    expect(capturedAgent?.config.persona).toBe("memory-extractor");
    expect(capturedAgent?.config.tools).toContain(VIEW_MEMORY_TOOL_NAME);
    expect(capturedAgent?.config.tools).toContain(MANAGE_MEMORY_TOOL_NAME);
    expect(capturedAgent?.config.memoryScopes).toEqual(["personal", "work"]);
    expect(capturedMaxIterations).toBeGreaterThan(0);
  });

  it("does nothing when there are no messages to scan", async () => {
    let called = false;
    const mockRunner: RecursiveRunner = () => {
      called = true;
      return Effect.succeed({ content: "", conversationId: "conv-1" } as AgentResponse);
    };
    const agent = createMockAgent();

    await Effect.runPromise(
      extractMemories([], agent, "conv-1", mockRunner).pipe(
        Effect.provide(createTestLayer()),
      ) as Effect.Effect<void, never, never>,
    );

    expect(called).toBe(false);
  });

  it("swallows extractor failures so it can never fail compaction", async () => {
    const failingRunner: RecursiveRunner = () =>
      Effect.fail(new LLMRequestError({ provider: "openai", message: "boom" }));
    const agent = createMockAgent();
    const messages: ChatMessage[] = [{ role: "user", content: "A durable fact." }];

    const result = await Effect.runPromise(
      extractMemories(messages, agent, "conv-1", failingRunner).pipe(
        Effect.provide(createTestLayer()),
      ) as Effect.Effect<void, never, never>,
    );

    expect(result).toBeUndefined();
  });
});

describe("compactIfNeeded memory-extraction gate", () => {
  const filler = "x ".repeat(200);
  const compactableMessages = (): ConversationMessages => [
    { role: "system", content: "You are an assistant" },
    { role: "user", content: `Do the task. ${filler}` },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      content: `Step ${index}. ${filler}`,
    })),
  ];

  it("invokes the extractor before summarizing when extraction is allowed", async () => {
    const seenAgentIds: string[] = [];
    const mockRunner: RecursiveRunner = (options) => {
      seenAgentIds.push(options.agent.id);
      return Effect.succeed({ content: "Summary.", conversationId: "conv-1" } as AgentResponse);
    };
    const agent = createMockAgent();

    await Effect.runPromise(
      Summarizer.compactIfNeeded(
        compactableMessages(),
        agent,
        "conv-1",
        mockRunner,
        500,
        true,
      ).pipe(Effect.provide(createTestLayer())) as Effect.Effect<
        ConversationMessages,
        Error,
        never
      >,
    );

    expect(seenAgentIds).toContain("memory-extractor");
    expect(seenAgentIds).toContain("summarizer");
    expect(seenAgentIds.indexOf("memory-extractor")).toBeLessThan(
      seenAgentIds.indexOf("summarizer"),
    );
  });

  it("does not invoke the extractor when extraction is not allowed (default)", async () => {
    const seenAgentIds: string[] = [];
    const mockRunner: RecursiveRunner = (options) => {
      seenAgentIds.push(options.agent.id);
      return Effect.succeed({ content: "Summary.", conversationId: "conv-1" } as AgentResponse);
    };
    const agent = createMockAgent();

    await Effect.runPromise(
      Summarizer.compactIfNeeded(compactableMessages(), agent, "conv-1", mockRunner, 500).pipe(
        Effect.provide(createTestLayer()),
      ) as Effect.Effect<ConversationMessages, Error, never>,
    );

    expect(seenAgentIds).not.toContain("memory-extractor");
    expect(seenAgentIds).toContain("summarizer");
  });
});
