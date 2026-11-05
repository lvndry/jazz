import { rejectEmptyCompletion } from "@jazz/core/agent/execution/empty-completion";
import type { ProviderName } from "@jazz/core/constants/models";
import type { LoggerService } from "@jazz/core/interfaces/logger";
import type { ChatCompletionResponse, StreamEvent } from "@jazz/core/types";
import { LLMRequestError, type LLMError } from "@jazz/core/types/errors";
import { convertToLLMError, isRetryableLLMError } from "@jazz/core/utils/llm-error";
import { describe, expect, it } from "bun:test";
import { Chunk, Effect } from "effect";
import {
  PROVIDER_STREAM_CASES,
  type CompletedExpectation,
  type ProviderStreamCase,
} from "./provider-stream-fixtures";
import { StreamProcessor } from "./stream-processor";

const silentLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

const LATE_USAGE_DELAY_MS = 20;

type RunResult =
  | {
      readonly kind: "completed";
      readonly events: StreamEvent[];
      readonly response: ChatCompletionResponse;
    }
  | { readonly kind: "failed"; readonly events: StreamEvent[]; readonly error: LLMError };

function buildFakeStreamResult(fixture: ProviderStreamCase): never {
  return {
    fullStream: (async function* () {
      yield* fixture.parts;
    })(),
    usage:
      fixture.usageDelivery === "result-promise-only"
        ? new Promise((resolve) => setTimeout(() => resolve(fixture.usage), LATE_USAGE_DELAY_MS))
        : Promise.resolve(fixture.usageDelivery === "finish-part" ? fixture.usage : undefined),
    providerMetadata: Promise.resolve(undefined),
    response: Promise.resolve({ messages: fixture.responseMessages }),
  } as never;
}

async function runCase(fixture: ProviderStreamCase): Promise<RunResult> {
  const events: StreamEvent[] = [];
  const processor = new StreamProcessor(
    {
      providerName: fixture.providerName,
      modelName: fixture.modelName,
      hasReasoningEnabled: true,
      startTime: Date.now(),
    },
    (effect) => {
      events.push(...Chunk.toArray(Effect.runSync(effect)));
    },
    silentLogger,
  );
  try {
    const response = await processor.process(buildFakeStreamResult(fixture));
    return { kind: "completed", events, response };
  } catch (thrown) {
    const error = convertToLLMError(thrown, fixture.providerName as ProviderName);
    return { kind: "failed", events, error };
  }
}

function indexOfType(events: readonly StreamEvent[], type: StreamEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}

function assertCompleted(
  fixture: ProviderStreamCase,
  result: RunResult,
  expected: CompletedExpectation,
): void {
  if (result.kind !== "completed") {
    throw new Error(`[${fixture.name}] expected completion, got ${result.error._tag}`);
  }
  const { events, response } = result;
  const types = events.map((event) => event.type);

  expect(types[0], fixture.name).toBe("stream_start");
  expect(types.at(-1), fixture.name).toBe("complete");
  expect(
    types.filter((type) => type === "complete"),
    fixture.name,
  ).toHaveLength(1);

  expect(response.content, fixture.name).toBe(expected.text);
  expect(response.finishReason, fixture.name).toBe(expected.finishReason);

  const emittedToolCallIds = events.flatMap((event) =>
    event.type === "tool_call" ? [event.toolCall.id] : [],
  );
  expect(emittedToolCallIds, fixture.name).toEqual(
    (response.toolCalls ?? []).map((call) => call.id),
  );
  expect(response.toolCalls ?? [], fixture.name).toHaveLength(expected.toolCalls.length);
  expected.toolCalls.forEach((expectedCall, index) => {
    const actual = response.toolCalls?.[index];
    expect(actual?.function.name, fixture.name).toBe(expectedCall.name);
    expect(typeof actual?.function.arguments, fixture.name).toBe("string");
    expect(JSON.parse(actual?.function.arguments ?? "null"), fixture.name).toEqual(
      expectedCall.input,
    );
    expect(actual?.invalidReason, fixture.name).toBeUndefined();
  });

  const thinkingStart = indexOfType(events, "thinking_start");
  const thinkingComplete = indexOfType(events, "thinking_complete");
  if (expected.reasoningText === undefined) {
    expect(thinkingStart, fixture.name).toBe(-1);
    expect(response.reasoning, fixture.name).toBeUndefined();
  } else {
    expect(thinkingStart, fixture.name).toBeGreaterThanOrEqual(0);
    expect(thinkingComplete, fixture.name).toBeGreaterThan(thinkingStart);
    const firstOutput = events.findIndex(
      (event) => event.type === "text_start" || event.type === "tool_call",
    );
    if (firstOutput >= 0) {
      expect(thinkingComplete, fixture.name).toBeLessThan(firstOutput);
    }
    expect(response.reasoning, fixture.name).toBe(expected.reasoningText);
  }

  expect(
    (response.reasoningParts ?? []).map((part) => ({
      provider: part.provider,
      hasProviderOptions: part.providerOptions !== undefined,
    })),
    fixture.name,
  ).toEqual([...expected.reasoningParts]);

  const usageUpdateIndex = indexOfType(events, "usage_update");
  const completeIndex = indexOfType(events, "complete");
  if (expected.promptTokens === undefined) {
    expect(usageUpdateIndex, fixture.name).toBe(-1);
    expect(response.usage, fixture.name).toBeUndefined();
  } else {
    expect(usageUpdateIndex, fixture.name).toBeGreaterThanOrEqual(0);
    expect(usageUpdateIndex, fixture.name).toBeLessThan(completeIndex);
    expect(response.usage?.promptTokens, fixture.name).toBe(expected.promptTokens);
    expect(response.usage?.cacheReadTokens, fixture.name).toBe(expected.cacheReadTokens);
    expect(response.usage?.cacheWriteTokens, fixture.name).toBe(expected.cacheWriteTokens);
    if (response.usage?.cacheReadTokens !== undefined) {
      expect(response.usage.cacheReadTokens, fixture.name).toBeLessThanOrEqual(
        response.usage.promptTokens,
      );
    }
  }

  const emptyFinishRejection = Effect.runSyncExit(
    rejectEmptyCompletion(
      { completion: response },
      {
        provider: fixture.providerName,
        model: fixture.modelName,
        agentId: "contract-agent",
        conversationId: "contract-conversation",
        logger: silentLogger,
      },
    ),
  );
  expect(emptyFinishRejection._tag === "Failure", fixture.name).toBe(expected.emptyFinishRetried);
}

describe("provider stream contract", () => {
  for (const fixture of PROVIDER_STREAM_CASES) {
    it(fixture.name, async () => {
      const result = await runCase(fixture);

      if (fixture.expected.outcome === "completed") {
        assertCompleted(fixture, result, fixture.expected.completion);
        return;
      }

      const { failure } = fixture.expected;
      if (result.kind !== "failed") {
        throw new Error(`[${fixture.name}] expected a failure, but the stream completed`);
      }
      expect(
        result.events.map((event) => event.type),
        fixture.name,
      ).not.toContain("complete");
      expect(result.error._tag, fixture.name).toBe(failure.errorTag);
      expect(isRetryableLLMError(result.error), fixture.name).toBe(failure.retryable);
      const permanent = result.error instanceof LLMRequestError && result.error.permanent === true;
      expect(permanent, fixture.name).toBe(failure.permanent);
    });
  }

  it("keeps a case for every behavior the contract names", () => {
    const names = PROVIDER_STREAM_CASES.map((fixture) => fixture.name).join("|");
    for (const required of [
      "deepseek thinking",
      "anthropic signed thinking",
      "split across deltas",
      "empty finish",
      "usage only on the result promise",
      "mid-stream",
      "unsupported option",
    ]) {
      expect(names).toContain(required);
    }
  });
});
