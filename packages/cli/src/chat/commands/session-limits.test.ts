import type { Agent } from "@jazz/core/types/agent";
import * as actualModelsDev from "@jazz/core/utils/models-dev";
import type { ModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { afterAll, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { partialFake } from "../../test-support/partial-fake";

let metadata: ModelsDevMetadata | undefined;

mock.module("@jazz/core/utils/models-dev", () => ({
  getModelsDevMetadata: () => Promise.resolve(metadata),
  getModelsDevProviderModels: () => Promise.resolve([]),
}));

afterAll(() => {
  mock.module("@jazz/core/utils/models-dev", () => actualModelsDev);
});

const {
  addRetryWasteToSession,
  estimateSessionCostUSD,
  findExceededSessionLimits,
  formatSessionLimitMetric,
} = await import("./session-limits");

const testAgent = partialFake<Agent>({
  id: "a",
  name: "A",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4" }, tools: [] },
});

describe("findExceededSessionLimits", () => {
  it("returns nothing when no limits are configured", () => {
    expect(findExceededSessionLimits({}, { turns: 100, costUSD: 100, tokens: 1_000_000 })).toEqual(
      [],
    );
  });

  it("flags a metric once usage reaches its limit", () => {
    const exceeded = findExceededSessionLimits(
      { maxTurns: 5 },
      { turns: 5, costUSD: 0, tokens: 0 },
    );
    expect(exceeded).toEqual([{ metric: "turns", limit: 5, used: 5 }]);
  });

  it("does not flag a metric below its limit", () => {
    expect(findExceededSessionLimits({ maxTurns: 5 }, { turns: 4, costUSD: 0, tokens: 0 })).toEqual(
      [],
    );
  });

  it("flags every exceeded metric at once", () => {
    const exceeded = findExceededSessionLimits(
      { maxTurns: 5, maxCostUSD: 1, maxTokens: 100 },
      { turns: 10, costUSD: 2, tokens: 200 },
    );
    expect(exceeded.map((overage) => overage.metric).sort()).toEqual(["tokens", "turns", "usd"]);
  });
});

describe("formatSessionLimitMetric", () => {
  it("formats turns with pluralization", () => {
    expect(formatSessionLimitMetric("turns", 1)).toBe("1 turn");
    expect(formatSessionLimitMetric("turns", 2)).toBe("2 turns");
  });

  it("formats usd to 2 decimals", () => {
    expect(formatSessionLimitMetric("usd", 5)).toBe("$5.00");
    expect(formatSessionLimitMetric("usd", 1.5)).toBe("$1.50");
  });

  it("formats tokens with locale separators", () => {
    expect(formatSessionLimitMetric("tokens", 100_000)).toBe("100,000 tokens");
  });
});

describe("estimateSessionCostUSD", () => {
  it("returns 0 when pricing metadata is unavailable", async () => {
    metadata = undefined;
    const cost = await Effect.runPromise(
      estimateSessionCostUSD(
        { requests: 1, promptTokens: 1_000_000, completionTokens: 1_000_000 },
        testAgent,
      ),
    );
    expect(cost).toBe(0);
  });

  it("prices accumulated tokens against input/output rates", async () => {
    metadata = { inputPricePerMillion: 3, outputPricePerMillion: 15 } as ModelsDevMetadata;
    const cost = await Effect.runPromise(
      estimateSessionCostUSD(
        { requests: 1, promptTokens: 1_000_000, completionTokens: 500_000 },
        testAgent,
      ),
    );
    expect(cost).toBeCloseTo(3 + 7.5);
  });

  it("adds what failed attempts wasted, which the token totals never held", async () => {
    metadata = { inputPricePerMillion: 3, outputPricePerMillion: 15 } as ModelsDevMetadata;
    const cost = await Effect.runPromise(
      estimateSessionCostUSD(
        { requests: 1, promptTokens: 1_000_000, completionTokens: 0, wastedUSD: 0.25 },
        testAgent,
      ),
    );
    expect(cost).toBeCloseTo(3.25);
  });
});

describe("addRetryWasteToSession", () => {
  const usage = { requests: 1, promptTokens: 10, completionTokens: 1 };

  it("leaves the session's retry fields alone when a response retried nothing", () => {
    expect(addRetryWasteToSession(usage, undefined)).toEqual({});
    expect(addRetryWasteToSession({ ...usage, retries: 2, wastedUSD: 0.5 }, undefined)).toEqual({
      retries: 2,
      wastedUSD: 0.5,
    });
  });

  it("adds retries and waste and keeps the lower-bound flag once set", () => {
    const first = addRetryWasteToSession(usage, { retries: 1, wastedUSD: 0.25, lowerBound: true });
    const second = addRetryWasteToSession(
      { ...usage, ...first },
      { retries: 2, wastedUSD: 0.5, lowerBound: false },
    );
    expect(second).toEqual({ retries: 3, wastedUSD: 0.75, wasteLowerBound: true });
  });

  it("keeps an unpriced waste unpriced", () => {
    expect(addRetryWasteToSession(usage, { retries: 1, lowerBound: true })).toEqual({
      retries: 1,
      wasteLowerBound: true,
    });
  });
});
