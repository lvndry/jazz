import { describe, expect, test } from "bun:test";
import { addStep, EMPTY_TURN, formatStepBreakdown, formatTurnReceipt } from "./turn-receipt";

describe("turn receipt", () => {
  test("sums every step of the turn into one row", () => {
    let turn = EMPTY_TURN;
    turn = addStep(turn, {
      durationMs: 5_900,
      promptTokens: 13_000,
      completionTokens: 46,
      costUSD: 0.03,
    });
    turn = addStep(turn, {
      durationMs: 3_800,
      promptTokens: 17_000,
      completionTokens: 56,
      costUSD: 0.03,
    });
    turn = addStep(turn, {
      durationMs: 7_400,
      promptTokens: 18_000,
      completionTokens: 213,
      costUSD: 0.0079,
    });
    expect(formatTurnReceipt(turn)).toBe("17.1s · 3 steps · 48k in → 315 out · $0.07");
  });

  test("a single-step turn does not count its steps", () => {
    const turn = addStep(EMPTY_TURN, {
      durationMs: 1_200,
      promptTokens: 900,
      completionTokens: 12,
    });
    expect(formatTurnReceipt(turn)).toBe("1.2s · 900 in → 12 out");
  });

  test("a provider with only a bare count still gets one", () => {
    const turn = addStep(EMPTY_TURN, { durationMs: 100, totalTokens: 42 });
    expect(formatTurnReceipt(turn)).toBe("0.1s · 42 tok");
  });

  test("an empty turn says nothing", () => {
    expect(formatTurnReceipt(EMPTY_TURN)).toBeUndefined();
  });

  test("the breakdown keeps per-step detail, speed included", () => {
    let turn = addStep(EMPTY_TURN, {
      durationMs: 4_100,
      promptTokens: 17_000,
      completionTokens: 101,
      cacheReadTokens: 13_430,
      tokensPerSecond: 35.7,
      costUSD: 0.01,
    });
    turn = addStep(turn, { durationMs: 1_000, promptTokens: 18_000, completionTokens: 5 });
    expect(formatStepBreakdown(turn)).toBe(
      "step 1 · 4.1s · 17k in → 101 out (79% cached) · 35.7 tok/s · $0.01\nstep 2 · 1.0s · 18k in → 5 out",
    );
  });
});

describe("turn decode throughput", () => {
  test("weights output tokens by generation time and excludes prefill", () => {
    const turn = {
      steps: [
        {
          durationMs: 10000,
          completionTokens: 100,
          generationDurationMs: 1000,
          tokensPerSecond: 100,
        },
        {
          durationMs: 20000,
          completionTokens: 900,
          generationDurationMs: 9000,
          tokensPerSecond: 100,
        },
      ],
    };
    expect(formatTurnReceipt(turn)).toBe("30.0s · 2 steps · 0 in → 1k out · 100.0 tok/s");
  });

  test("does not average per-step rates", () => {
    const turn = {
      steps: [
        { durationMs: 1000, completionTokens: 10, tokensPerSecond: 10 },
        { durationMs: 9000, completionTokens: 900, tokensPerSecond: 100 },
      ],
    };
    expect(formatTurnReceipt(turn)).toContain("91.0 tok/s");
  });

  test("omits throughput when any producing step has unknown generation timing", () => {
    expect(
      formatTurnReceipt({
        steps: [
          { durationMs: 1000, completionTokens: 10, generationDurationMs: 100 },
          { durationMs: 2000, completionTokens: 20 },
        ],
      }),
    ).not.toContain("tok/s");
  });
});
