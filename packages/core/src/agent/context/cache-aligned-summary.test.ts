import { beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { Summarizer, type CompactionOutcome, type RecursiveRunner } from "./summarizer";
import { AgentConfigServiceTag, type AgentConfigService } from "../../interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../../interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "../../interfaces/presentation";
import { partialFake } from "../../test-support/fakes";
import type { Agent, AppConfig } from "../../types";
import type { ChatCompletionOptions, ChatCompletionResponse } from "../../types/chat";
import { LLMRequestError } from "../../types/errors";
import type { ConversationMessages } from "../../types/message";
import type { ToolDefinition } from "../../types/tools";
import {
  createAgentRunMetrics,
  computeRunCost,
  type AgentRunMetrics,
} from "../metrics/agent-run-metrics";
import {
  classifyCacheChange,
  fingerprintRequest,
  lastCacheObservation,
  promptCacheKey,
  resetCacheLedger,
  toolFingerprintInput,
} from "../metrics/prompt-cache";
import { observePromptCache } from "../metrics/prompt-cache-observer";
import type { AgentResponse } from "../types";

const PROVIDER = "openai" as const;
const MODEL = "gpt-4";
const CONTEXT_WINDOW_TOKENS = 12_000;
const PRICING = {
  inputPricePerMillion: 2,
  outputPricePerMillion: 8,
  cacheReadPricePerMillion: 0.5,
};
const SUMMARY_TEXT = "## Goal\n\nShip the thing.";

const logger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setLogGroup: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
};

const appConfig: AppConfig = {
  storage: { type: "file", path: "/tmp/test" },
  logging: { level: "info", format: "plain" },
};

const configService: AgentConfigService = {
  appConfig: Effect.succeed(appConfig),
  get: <Value>(_key: string) => Effect.succeed(undefined as Value),
  getOrElse: <Value>(_key: string, fallback: Value) => Effect.succeed(fallback),
  getOrFail: <Value>(_key: string) => Effect.succeed(undefined as Value),
  has: () => Effect.succeed(false),
  set: () => Effect.void,
  revision: Effect.succeed(0),
  secretStorageUnavailable: () => false,
  reloadIfChanged: () => Effect.succeed(false),
};

const presentation = partialFake<PresentationService>({
  presentWarning: () => Effect.void,
});

function makeAgent(summarizerModel?: string): Agent {
  return {
    id: "aligned-summary-agent",
    name: "Aligned",
    description: "test agent",
    config: {
      llm: {
        provider: PROVIDER,
        model: MODEL,
        ...(summarizerModel !== undefined ? { summarizerModel } : {}),
      },
      persona: "default",
      tools: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTools(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: z.object({ path: z.string() }),
      },
    },
  ];
}

function makeConversation(): ConversationMessages {
  const messages: ConversationMessages = [{ role: "system", content: "the real system prompt" }];
  for (let index = 0; index < 16; index++) {
    messages.push({ role: "user", content: `ask ${index} ` + "detail ".repeat(100) });
    messages.push({ role: "assistant", content: `answer ${index} ` + "text ".repeat(100) });
  }
  return messages;
}

interface Harness {
  readonly requests: ChatCompletionOptions[];
  readonly runnerInputs: string[];
  readonly metrics: AgentRunMetrics;
  readonly conversationKey: string;
  readonly previousMessages: ConversationMessages;
  readonly tools: ToolDefinition[];
  compact(options: {
    readonly agent?: Agent;
    readonly pricing?: typeof PRICING | undefined;
    readonly respond?: () => Effect.Effect<ChatCompletionResponse, LLMRequestError>;
  }): Promise<CompactionOutcome | undefined>;
}

let harnessCounter = 0;

/**
 * Plays the agent loop: sends a request through the cache observer, appends what the loop would
 * have appended, then compacts with the alignment the loop passes.
 */
async function makeHarness(): Promise<Harness> {
  harnessCounter += 1;
  const conversationId = `aligned-conv-${String(harnessCounter)}`;
  const agent = makeAgent();
  const tools = makeTools();
  const previousMessages = makeConversation();
  const metrics = createAgentRunMetrics({
    agent,
    conversationId,
    provider: PROVIDER,
    model: MODEL,
  });
  const conversationKey = promptCacheKey(agent.id, conversationId);
  const scope = {
    logger,
    runMetrics: metrics,
    conversationKey,
    provider: PROVIDER,
    model: MODEL,
    emit: undefined,
  };
  await Effect.runPromise(observePromptCache(scope, tools, previousMessages));

  const requests: ChatCompletionOptions[] = [];
  const runnerInputs: string[] = [];
  const runner: RecursiveRunner = (options) => {
    runnerInputs.push(options.userInput);
    return Effect.succeed({
      content: "stand-alone summary",
      conversationId,
    } as AgentResponse);
  };
  const history: ConversationMessages = [
    ...previousMessages,
    { role: "user", content: "one more thing" },
    { role: "assistant", content: "on it" },
  ];

  return {
    requests,
    runnerInputs,
    metrics,
    conversationKey,
    previousMessages,
    tools,
    async compact(options) {
      const { agent: agentOverride, respond } = options;
      const pricing = "pricing" in options ? options.pricing : PRICING;
      const llm = partialFake<LLMService>({
        createChatCompletion: (_provider: string, request: ChatCompletionOptions) => {
          requests.push(request);
          return (
            respond?.() ??
            Effect.succeed<ChatCompletionResponse>({
              id: "summary",
              model: MODEL,
              content: SUMMARY_TEXT,
              finishReason: "stop",
              usage: {
                promptTokens: 5000,
                completionTokens: 200,
                totalTokens: 5200,
                cacheReadTokens: 4500,
              },
            })
          );
        },
        resolveLocalProviderBaseUrl: () => "",
      });
      const layer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, logger),
        Layer.succeed(AgentConfigServiceTag, configService),
        Layer.succeed(LLMServiceTag, llm),
        Layer.succeed(PresentationServiceTag, presentation),
      );
      return Effect.runPromise(
        Summarizer.compact(
          history,
          agentOverride ?? agent,
          conversationId,
          runner,
          CONTEXT_WINDOW_TOKENS,
          false,
          undefined,
          undefined,
          undefined,
          { tools, cacheScope: scope, pricing },
        ).pipe(Effect.provide(layer)) as Effect.Effect<CompactionOutcome | undefined, Error, never>,
      );
    },
  };
}

describe("cache-aligned compaction summary", () => {
  beforeEach(() => {
    resetCacheLedger();
  });

  it("sends the summary as an append to the previous request, with the same tools and system prompt", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({});

    expect(outcome?.messages.some((message) => message.content === SUMMARY_TEXT)).toBe(true);
    expect(harness.runnerInputs).toHaveLength(0);
    expect(harness.requests).toHaveLength(1);
    const [request] = harness.requests;
    expect(request?.toolChoice).toBe("none");

    const previous = fingerprintRequest({
      provider: PROVIDER,
      model: MODEL,
      tools: harness.tools.map(toolFingerprintInput),
      messages: harness.previousMessages,
    });
    const sent = fingerprintRequest({
      provider: PROVIDER,
      model: MODEL,
      tools: (request?.tools ?? []).map(toolFingerprintInput),
      messages: request?.messages ?? [],
    });
    expect(sent.toolsHash).toBe(previous.toolsHash);
    expect(sent.systemHash).toBe(previous.systemHash);
    expect(sent.messageHashes.slice(0, previous.messageHashes.length)).toEqual([
      ...previous.messageHashes,
    ]);
    expect(sent.messageHashes.length).toBeGreaterThan(previous.messageHashes.length);
    expect(classifyCacheChange(previous, sent).reason).toBe("none");
    expect(lastCacheObservation(harness.conversationKey)?.change.reason).toBe("none");
  });

  it("computes the step's hit rate from the provider's cache figures like any request", async () => {
    const harness = await makeHarness();

    await harness.compact({});

    expect(lastCacheObservation(harness.conversationKey)?.hitRate).toBeCloseTo(0.9, 5);
  });

  it("records the summary call as side spend priced with cache reads", async () => {
    const harness = await makeHarness();

    await harness.compact({});

    const expected = (500 / 1e6) * 2 + (4500 / 1e6) * 0.5 + (200 / 1e6) * 8;
    expect(harness.metrics.sideCostUSD).toBeCloseTo(expected, 10);
    expect(harness.metrics.sideCostUnknown).toBe(false);
    expect(computeRunCost(harness.metrics, PRICING).costUSD).toBeCloseTo(expected, 8);
  });

  it("marks the run's cost incomplete when the provider reports no usage", async () => {
    const harness = await makeHarness();

    await harness.compact({
      respond: () =>
        Effect.succeed({
          id: "summary",
          model: MODEL,
          content: SUMMARY_TEXT,
          finishReason: "stop",
        }),
    });

    expect(harness.metrics.sideCostUnknown).toBe(true);
  });

  it("uses the stand-alone summarizer when the summarizer model differs", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({ agent: makeAgent("openai/gpt-4o-mini") });

    expect(harness.requests).toHaveLength(0);
    expect(harness.runnerInputs).toHaveLength(1);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
  });

  it("uses the stand-alone summarizer when the model has no cache-read price", async () => {
    const harness = await makeHarness();

    await harness.compact({ pricing: undefined });

    expect(harness.requests).toHaveLength(0);
    expect(harness.runnerInputs).toHaveLength(1);
  });

  it("uses the stand-alone summarizer when the history no longer matches the previous request", async () => {
    const harness = await makeHarness();
    const rewritten = [...harness.previousMessages];
    rewritten[1] = { role: "user", content: "an earlier message that was rewritten" };
    await Effect.runPromise(
      observePromptCache(
        {
          logger,
          runMetrics: harness.metrics,
          conversationKey: harness.conversationKey,
          provider: PROVIDER,
          model: MODEL,
          emit: undefined,
        },
        harness.tools,
        rewritten,
      ),
    );

    await harness.compact({});

    expect(harness.requests).toHaveLength(0);
    expect(harness.runnerInputs).toHaveLength(1);
  });

  it("discards a tool call the model makes anyway and falls back, still paying for the call", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({
      respond: () =>
        Effect.succeed({
          id: "summary",
          model: MODEL,
          content: SUMMARY_TEXT,
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
          usage: { promptTokens: 5000, completionTokens: 50, totalTokens: 5050 },
        }),
    });

    expect(harness.requests).toHaveLength(1);
    expect(harness.runnerInputs).toHaveLength(1);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
    expect(harness.metrics.sideCostUSD).toBeGreaterThan(0);
  });

  it("falls back when the summary request fails", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({
      respond: () => Effect.fail(new LLMRequestError({ provider: PROVIDER, message: "boom" })),
    });

    expect(harness.runnerInputs).toHaveLength(1);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
  });

  it("still rejects a truncated summary instead of replacing history with half a checkpoint", async () => {
    const harness = await makeHarness();

    const attempt = harness.compact({
      respond: () =>
        Effect.succeed({
          id: "summary",
          model: MODEL,
          content: SUMMARY_TEXT,
          finishReason: "length",
        }),
    });

    await expect(attempt).rejects.toThrow();
    expect(harness.runnerInputs).toHaveLength(0);
  });
});
