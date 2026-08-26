import { describe, expect, test } from "bun:test";
import { computeUsageCostUSD } from "./usage-cost";

describe("computeUsageCostUSD", () => {
  test("returns null when no pricing is known", () => {
    expect(
      computeUsageCostUSD({ promptTokens: 1000, completionTokens: 100 }, undefined),
    ).toBeNull();
    expect(computeUsageCostUSD({ promptTokens: 1000, completionTokens: 100 }, {})).toBeNull();
  });

  test("prices uncached input and output at full rates", () => {
    const cost = computeUsageCostUSD(
      { promptTokens: 1_000_000, completionTokens: 500_000 },
      { inputPricePerMillion: 2, outputPricePerMillion: 8 },
    );
    expect(cost).toBeCloseTo(2 + 4, 10);
  });

  test("bills the cached share at the cache-read rate", () => {
    const cost = computeUsageCostUSD(
      { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 900_000 },
      { inputPricePerMillion: 2, outputPricePerMillion: 8, cacheReadPricePerMillion: 0.2 },
    );
    expect(cost).toBeCloseTo(0.1 * 2 + 0.9 * 0.2, 10);
  });

  test("falls back to the full input rate when no cache-read price exists", () => {
    const cost = computeUsageCostUSD(
      { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 900_000 },
      { inputPricePerMillion: 2 },
    );
    expect(cost).toBeCloseTo(2, 10);
  });

  test("clamps cacheReadTokens to promptTokens", () => {
    const cost = computeUsageCostUSD(
      { promptTokens: 100, completionTokens: 0, cacheReadTokens: 500 },
      { inputPricePerMillion: 2, cacheReadPricePerMillion: 0.2 },
    );
    expect(cost).toBeCloseTo((100 / 1_000_000) * 0.2, 12);
  });
});
