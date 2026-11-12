/**
 * Replay the loop's cache observations around compaction with a recording LLM service.
 * Verify request-prefix reuse, summary-specific options, fallback behavior and accounting
 * without contacting a provider or mutating the parent agent's settings.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
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
  runRetryWaste,
  type AgentRunMetrics,
} from "../metrics/agent-run-metrics";
import {
  classifyCacheChange,
  fingerprintRequest,
  lastCacheObservation,
  promptCacheKey,
  recordCacheUsage,
  resetCacheLedger,
  toolFingerprintInput,
} from "../metrics/prompt-cache";
import { observePromptCache } from "../metrics/prompt-cache-observer";
import type { AgentResponse } from "../types";
import {
  Summarizer,
  summaryRequestPrefix,
  type CompactionOutcome,
  type RecursiveRunner,
} from "./summarizer";

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
  readonly history: ConversationMessages;
  readonly tools: ToolDefinition[];
  compact(options: {
    readonly agent?: Agent;
    readonly pricing?: typeof PRICING | undefined;
    readonly respond?: () => Effect.Effect<ChatCompletionResponse, LLMRequestError>;
    readonly trigger?: "automatic" | "manual";
  }): Promise<CompactionOutcome | undefined>;
}

let harnessCounter = 0;

/**
 * Plays the agent loop: sends a request through the cache observer, appends what the loop would
 * have appended, then compacts with the alignment the loop passes.
 */
async function makeHarness(tools = makeTools()): Promise<Harness> {
  harnessCounter += 1;
  const conversationId = `aligned-conv-${String(harnessCounter)}`;
  const agent = makeAgent();
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
    history,
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
          { trigger: options.trigger ?? "automatic", tools, cacheScope: scope, pricing },
        ).pipe(Effect.provide(layer)) as Effect.Effect<CompactionOutcome | undefined, Error, never>,
      );
    },
  };
}

describe("cache-aligned compaction summary", () => {
  beforeEach(() => {
    resetCacheLedger();
  });

  it("preserves the conversation's reasoning setting for the summary", async () => {
    const harness = await makeHarness();
    const base = makeAgent();
    const agent: Agent = {
      ...base,
      config: { ...base.config, llm: { ...base.config.llm, reasoning: "high" } },
    };

    await harness.compact({ agent });

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.reasoning).toBe("high");
    expect(agent.config.llm.reasoning).toBe("high");
  });

  it("sends the summary as an append to the previous request, with the same tools and system prompt", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({});

    expect(outcome?.messages.some((message) => message.content === SUMMARY_TEXT)).toBe(true);
    expect(harness.runnerInputs).toHaveLength(0);
    expect(harness.requests).toHaveLength(1);
    const [request] = harness.requests;
    expect(request?.toolChoice).toBe("none");
    expect(request?.messages.at(-1)?.kind).toBe("ephemeral");

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

  it("keeps an oversized tool schema out of the aligned request", async () => {
    const tools = makeTools();
    const tool = tools[0];
    if (tool === undefined) {
      throw new Error("missing tool fixture");
    }
    tool.function.description = "long schema description ".repeat(20_000);
    const harness = await makeHarness(tools);
    await harness.compact({});
    expect(harness.requests).toHaveLength(0);
    expect(harness.runnerInputs).toHaveLength(1);
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

  it("reuses an unpriced provider's prefix after it reports actual cache reads", async () => {
    const harness = await makeHarness();
    recordCacheUsage(harness.conversationKey, { promptTokens: 5000, cacheReadTokens: 4500 });

    await harness.compact({ pricing: undefined, trigger: "manual" });

    expect(harness.requests).toHaveLength(1);
    expect(harness.runnerInputs).toHaveLength(0);
    expect(harness.metrics.sideCostUnknown).toBe(true);
    expect(harness.requests[0]?.messages).toHaveLength(harness.history.length + 1);
  });

  it("shortens a manual request only to a completed earlier request boundary", async () => {
    const harness = await makeHarness();
    const prefix = summaryRequestPrefix(
      harness.history,
      Summarizer.splitMessages(harness.history, CONTEXT_WINDOW_TOKENS, {
        provider: PROVIDER,
        modelId: MODEL,
      }).messagesToSummarize,
    );
    if (!prefix) {
      throw new Error("Missing prefix fixture");
    }
    const scope = {
      logger,
      runMetrics: harness.metrics,
      conversationKey: harness.conversationKey,
      provider: PROVIDER,
      model: MODEL,
      emit: undefined,
    };
    await Effect.runPromise(observePromptCache(scope, harness.tools, prefix.history));
    recordCacheUsage(harness.conversationKey, { promptTokens: 1000 });
    await Effect.runPromise(observePromptCache(scope, harness.tools, harness.previousMessages));
    recordCacheUsage(harness.conversationKey, { promptTokens: 5000, cacheReadTokens: 4500 });

    await harness.compact({ trigger: "manual" });

    expect(harness.runnerInputs).toHaveLength(0);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.messages.slice(0, -1)).toEqual(prefix.history);
    expect(harness.requests[0]?.messages.length).toBeLessThan(harness.history.length);
  });

  it("does not infer caching support from zero cache reads", async () => {
    const harness = await makeHarness();
    recordCacheUsage(harness.conversationKey, { promptTokens: 5000, cacheReadTokens: 0 });

    await harness.compact({ pricing: undefined });

    expect(harness.requests).toHaveLength(0);
    expect(harness.runnerInputs).toHaveLength(1);
  });

  it("keeps automatic compaction's existing pricing requirement", async () => {
    const harness = await makeHarness();
    recordCacheUsage(harness.conversationKey, { promptTokens: 5000, cacheReadTokens: 4500 });

    await harness.compact({ pricing: undefined, trigger: "automatic" });

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
      respond: () =>
        Effect.fail(
          new LLMRequestError({ provider: PROVIDER, message: "boom", unreadableResponse: true }),
        ),
    });

    expect(harness.runnerInputs).toHaveLength(1);
    expect(harness.metrics.retryWaste.unknownUsageAttempts).toBe(1);
    expect(runRetryWaste(harness.metrics, PRICING).lowerBound).toBe(true);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
  });

  it("falls back when an aligned summary is truncated", async () => {
    const harness = await makeHarness();

    const outcome = await harness.compact({
      respond: () =>
        Effect.succeed({
          id: "summary",
          model: MODEL,
          content: SUMMARY_TEXT,
          finishReason: "length",
        }),
    });

    expect(harness.runnerInputs).toHaveLength(1);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
  });
  it("falls back when the aligned model returns an empty checkpoint", async () => {
    const harness = await makeHarness();
    const outcome = await harness.compact({
      respond: () => Effect.succeed({ id: "empty", model: MODEL, content: "" }),
    });
    expect(harness.runnerInputs).toHaveLength(1);
    expect(outcome?.messages.some((message) => message.content === "stand-alone summary")).toBe(
      true,
    );
  });
});
