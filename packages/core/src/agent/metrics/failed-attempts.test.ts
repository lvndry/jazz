import { describe, expect, it } from "bun:test";
import { partialFake } from "@/core/test-support/fakes";
import { computeRunCost, classifyFailedAttempt, recordFailedAttempt } from "./agent-run-metrics";
import type { AgentRunMetrics } from "./agent-run-metrics";
import {
  MAX_FAILED_ATTEMPT_RECORDS,
  SUBSTANTIAL_STREAMED_CHARS,
  addFailedAttempt,
  addFailedAttemptReceipt,
  computeRetryWaste,
  createRetryWasteTally,
  formatRetryWaste,
  type FailedAttemptObservation,
} from "./failed-attempts";
import { LLMRequestError } from "../../types/errors";

const PRICING = { inputPricePerMillion: 3, outputPricePerMillion: 15 };
const formatAmount = (usd: number) => `$${usd.toFixed(2)}`;

function observation(overrides: Partial<FailedAttemptObservation> = {}): FailedAttemptObservation {
  return {
    reason: "provider",
    error: new LLMRequestError({ provider: "openai", message: "overloaded", statusCode: 503 }),
    mode: "streaming",
    provider: "openai",
    model: "gpt-4",
    durationMs: 1_200,
    streamedChars: 0,
    toolCallStarted: false,
    ...overrides,
  };
}

describe("failed attempt records", () => {
  it("records sizes and flags, with the status code and usage the provider reported", () => {
    const tally = createRetryWasteTally();
    const record = addFailedAttempt(
      tally,
      observation({
        streamedChars: 40,
        toolCallStarted: true,
        usage: { promptTokens: 1_000, completionTokens: 20 },
      }),
      true,
    );

    expect(record).toEqual({
      index: 1,
      reason: "provider",
      statusCode: 503,
      mode: "streaming",
      provider: "openai",
      model: "gpt-4",
      durationMs: 1_200,
      streamedChars: 40,
      toolCallStarted: true,
      usage: { promptTokens: 1_000, completionTokens: 20 },
    });
  });

  it("keeps no streamed content, whatever the error message holds", () => {
    const secret = "sk-live-secret-in-the-stream";
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({
        error: new LLMRequestError({ provider: "openai", message: secret }),
        streamedChars: secret.length,
      }),
      true,
    );

    expect(JSON.stringify(tally)).not.toContain(secret);
  });

  it("stops keeping records at the bound while the totals keep counting", () => {
    const tally = createRetryWasteTally();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPT_RECORDS + 5; attempt += 1) {
      addFailedAttempt(
        tally,
        observation({ usage: { promptTokens: 10, completionTokens: 1 } }),
        true,
      );
    }

    expect(tally.records).toHaveLength(MAX_FAILED_ATTEMPT_RECORDS);
    expect(tally.failedAttempts).toBe(MAX_FAILED_ATTEMPT_RECORDS + 5);
    expect(tally.promptTokens).toBe((MAX_FAILED_ATTEMPT_RECORDS + 5) * 10);
  });

  it("counts retries after substantial output, by characters or by a started tool call", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(tally, observation({ streamedChars: SUBSTANTIAL_STREAMED_CHARS - 1 }), true);
    expect(tally.retriesAfterSubstantialOutput).toBe(0);
    addFailedAttempt(tally, observation({ streamedChars: SUBSTANTIAL_STREAMED_CHARS }), true);
    addFailedAttempt(tally, observation({ toolCallStarted: true }), true);
    expect(tally.retriesAfterSubstantialOutput).toBe(2);
  });

  it("refines the shared error category with the retry-specific flags", () => {
    expect(
      classifyFailedAttempt(
        new LLMRequestError({ provider: "p", message: "m", emptyResponse: true }),
      ),
    ).toBe("empty_response");
    expect(
      classifyFailedAttempt(
        new LLMRequestError({ provider: "p", message: "m", streamStalled: true }),
      ),
    ).toBe("stream_stalled");
    expect(classifyFailedAttempt(new LLMRequestError({ provider: "p", message: "m" }))).toBe(
      "provider",
    );
  });
});

describe("retry waste", () => {
  it("prices reported usage, input tokens included", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 1_000_000, completionTokens: 0 } }),
      true,
    );
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 0, completionTokens: 100_000 } }),
      true,
    );

    const waste = computeRetryWaste(tally, PRICING, false);

    expect(waste).toEqual({ retries: 2, wastedUSD: 4.5, lowerBound: false, unpriced: false });
  });

  it("prefers a provider-billed price and does not price those tokens again", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 1_000_000, completionTokens: 0, billedCostUSD: 0.5 } }),
      true,
    );
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 1_000_000, completionTokens: 0 } }),
      true,
    );

    expect(computeRetryWaste(tally, PRICING, false).wastedUSD).toBe(3.5);
  });

  it("leaves the figure a lower bound when an attempt streamed output but reported no usage", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 1_000_000, completionTokens: 0 } }),
      true,
    );
    addFailedAttempt(tally, observation({ streamedChars: 500 }), true);

    const waste = computeRetryWaste(tally, PRICING, false);

    expect(waste.wastedUSD).toBe(3);
    expect(waste.lowerBound).toBe(true);
    expect(waste.unpriced).toBe(false);
  });

  it("flags a stalled stream with no usage as unknown, and an output-free failure as nothing billed", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(tally, observation({ reason: "stream_stalled" }), true);
    addFailedAttempt(tally, observation({ reason: "provider" }), true);

    expect(tally.unknownUsageAttempts).toBe(1);
    expect(computeRetryWaste(tally, PRICING, false)).toMatchObject({
      wastedUSD: 0,
      lowerBound: true,
    });
  });

  it("reports unknown, not zero, when usage was reported but the model has no pricing", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 500, completionTokens: 5 } }),
      true,
    );

    const waste = computeRetryWaste(tally, undefined, false);

    expect(waste.wastedUSD).toBeUndefined();
    expect(waste.lowerBound).toBe(true);
    expect(waste.unpriced).toBe(true);
  });

  it("wastes nothing on a free local model", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(tally, observation({ streamedChars: 900 }), true);

    expect(computeRetryWaste(tally, undefined, true)).toEqual({
      retries: 1,
      wastedUSD: 0,
      lowerBound: false,
      unpriced: false,
    });
  });

  it("does not count a failure the loop will not retry as a retry", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(tally, observation(), false);

    expect(computeRetryWaste(tally, PRICING, false).retries).toBe(0);
    expect(tally.failedAttempts).toBe(1);
  });

  it("folds a renderer's retried attempts the same way", () => {
    const tally = createRetryWasteTally();
    addFailedAttemptReceipt(tally, { promptTokens: 1_000_000, completionTokens: 0 }, false, true);
    addFailedAttemptReceipt(tally, undefined, true, true);

    expect(computeRetryWaste(tally, PRICING, false)).toEqual({
      retries: 2,
      wastedUSD: 3,
      lowerBound: true,
      unpriced: false,
    });
  });
});

describe("retry waste in the run's cost", () => {
  function metricsWith(tally: AgentRunMetrics["retryWaste"]) {
    return {
      totalPromptTokens: 1_000_000,
      totalCompletionTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      childCostUSD: 0,
      childCostUnknown: false,
      sideCostUSD: 0,
      sideCostUnknown: false,
      usageMissing: false,
      retryWaste: tally,
      decisionCostUSD: 0,
      decisionCostUnknown: false,
      provider: "openai",
      model: "gpt-4",
    };
  }

  it("adds the waste once on top of the run's own tokens", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 1_000_000, completionTokens: 0 } }),
      true,
    );

    const cost = computeRunCost(metricsWith(tally), PRICING);

    expect(cost.costUSD).toBe(6);
    expect(cost.costIncomplete).toBe(false);
  });

  it("does not make the run's cost incomplete for a lower bound alone", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(tally, observation({ streamedChars: 900 }), true);

    const cost = computeRunCost(metricsWith(tally), PRICING);

    expect(cost.costUSD).toBe(3);
    expect(cost.costIncomplete).toBe(false);
  });

  it("makes it incomplete when reported usage could not be priced", () => {
    const tally = createRetryWasteTally();
    addFailedAttempt(
      tally,
      observation({ usage: { promptTokens: 100, completionTokens: 1 } }),
      true,
    );

    const noOwnTokens = { ...metricsWith(tally), totalPromptTokens: 0 };

    expect(computeRunCost(noOwnTokens, PRICING).costIncomplete).toBe(false);
    expect(computeRunCost(noOwnTokens, undefined).costIncomplete).toBe(true);
  });

  it("recordFailedAttempt still counts the retry and keeps the usage out of the run's own tokens", () => {
    const metrics = partialFake<AgentRunMetrics>({
      llmRetryCount: 0,
      errors: [],
      currentIteration: undefined,
      retryWaste: createRetryWasteTally(),
      totalPromptTokens: 0,
    });

    recordFailedAttempt(
      metrics,
      { ...observation(), usage: { promptTokens: 700, completionTokens: 0 } },
      true,
    );

    expect(metrics.llmRetryCount).toBe(1);
    expect(metrics.totalPromptTokens).toBe(0);
    expect(metrics.retryWaste.promptTokens).toBe(700);
  });
});

describe("formatRetryWaste", () => {
  const waste = (overrides: Partial<Parameters<typeof formatRetryWaste>[0]>) => ({
    retries: 2,
    wastedUSD: 0.03,
    lowerBound: true,
    unpriced: false,
    ...overrides,
  });

  it("says nothing when no retry or waste was recorded", () => {
    expect(
      formatRetryWaste(waste({ retries: 0, wastedUSD: 0, lowerBound: false }), formatAmount),
    ).toBeUndefined();
  });

  it("still shows failed spend when the retry budget was zero", () => {
    expect(formatRetryWaste(waste({ retries: 0 }), formatAmount)).toBe(
      "failed attempt, wasted >= $0.03",
    );
  });

  it("labels a lower bound", () => {
    expect(formatRetryWaste(waste({}), formatAmount)).toBe("retries: 2, wasted >= $0.03");
  });

  it("drops the label when the figure is exact", () => {
    expect(formatRetryWaste(waste({ lowerBound: false }), formatAmount)).toBe(
      "retries: 2, wasted $0.03",
    );
  });

  it("says unknown when output may have been billed but nothing is priced", () => {
    expect(formatRetryWaste(waste({ wastedUSD: undefined }), formatAmount)).toBe(
      "retries: 2, wasted unknown",
    );
    expect(formatRetryWaste(waste({ wastedUSD: 0 }), formatAmount)).toBe(
      "retries: 2, wasted unknown",
    );
  });

  it("shows only the count when nothing was billed", () => {
    expect(formatRetryWaste(waste({ wastedUSD: 0, lowerBound: false }), formatAmount)).toBe(
      "retries: 2",
    );
  });
});
