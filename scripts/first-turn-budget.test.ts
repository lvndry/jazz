import { describe, expect, test } from "bun:test";
import {
  SYSTEM_PROMPT_HEADROOM_TOKENS,
  TOOL_COUNT_HEADROOM,
  TOOL_SCHEMA_HEADROOM_TOKENS,
  firstTurnCeilings,
  firstTurnFailures,
  firstTurnLoweringHints,
  firstTurnTotals,
  largestToolSchemas,
  type FirstTurnBaseline,
  type FirstTurnMeasurement,
} from "./first-turn-budget";

const baseline: FirstTurnBaseline = {
  systemPromptTokens: 1000,
  toolSchemaTokens: 300,
  toolCount: 3,
};

function measurement(overrides: Partial<FirstTurnMeasurement> = {}): FirstTurnMeasurement {
  return {
    systemPromptTokens: 1000,
    toolSchemas: [
      { name: "alpha", tokens: 100 },
      { name: "beta", tokens: 100 },
      { name: "gamma", tokens: 100 },
    ],
    ...overrides,
  };
}

describe("first-turn budget", () => {
  test("totals sum the schemas and count the tools", () => {
    expect(firstTurnTotals(measurement())).toEqual({
      systemPromptTokens: 1000,
      toolSchemaTokens: 300,
      toolCount: 3,
      totalTokens: 1300,
    });
  });

  test("ceilings are the baseline plus the named headroom", () => {
    expect(firstTurnCeilings(baseline)).toEqual({
      systemPromptTokens: 1000 + SYSTEM_PROMPT_HEADROOM_TOKENS,
      toolSchemaTokens: 300 + TOOL_SCHEMA_HEADROOM_TOKENS,
      toolCount: 3 + TOOL_COUNT_HEADROOM,
    });
  });

  test("passes at the ceiling", () => {
    const atCeiling = measurement({
      systemPromptTokens: 1000 + SYSTEM_PROMPT_HEADROOM_TOKENS,
      toolSchemas: [{ name: "alpha", tokens: 300 + TOOL_SCHEMA_HEADROOM_TOKENS }],
    });
    expect(firstTurnFailures(atCeiling, baseline)).toEqual([]);
  });

  test("a grown system prompt fails alone and names its excess", () => {
    const failures = firstTurnFailures(
      measurement({ systemPromptTokens: 1000 + SYSTEM_PROMPT_HEADROOM_TOKENS + 25 }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("system prompt:");
    expect(failures[0]).toContain("by 25");
  });

  test("grown schemas fail without failing the prompt or the count", () => {
    const failures = firstTurnFailures(
      measurement({
        toolSchemas: [
          { name: "alpha", tokens: 150 + TOOL_SCHEMA_HEADROOM_TOKENS },
          { name: "beta", tokens: 100 },
          { name: "gamma", tokens: 100 },
        ],
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("tool schemas:");
    expect(failures[0]).toContain("by 50");
  });

  test("a new eager tool fails the count", () => {
    const failures = firstTurnFailures(
      measurement({
        toolSchemas: [
          { name: "alpha", tokens: 50 },
          { name: "beta", tokens: 50 },
          { name: "gamma", tokens: 50 },
          { name: "delta", tokens: 50 },
        ],
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("eager tool count:");
  });

  test("every grown part is reported", () => {
    const failures = firstTurnFailures(
      measurement({
        systemPromptTokens: 5000,
        toolSchemas: Array.from({ length: 9 }, (_unused, index) => ({
          name: `tool_${String(index)}`,
          tokens: 500,
        })),
      }),
      baseline,
    );
    expect(failures).toHaveLength(3);
  });

  test("lowering hints appear only once a part is below its baseline by more than the headroom", () => {
    expect(firstTurnLoweringHints(measurement(), baseline)).toEqual([]);
    const trimmed = measurement({
      systemPromptTokens: 1000 - SYSTEM_PROMPT_HEADROOM_TOKENS - 1,
    });
    const hints = firstTurnLoweringHints(trimmed, baseline);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toStartWith("system prompt");
  });

  test("largest schemas sort by tokens then name and respect the limit", () => {
    const ranked = largestToolSchemas(
      [
        { name: "b", tokens: 5 },
        { name: "a", tokens: 5 },
        { name: "c", tokens: 9 },
        { name: "d", tokens: 1 },
      ],
      3,
    );
    expect(ranked.map((tool) => tool.name)).toEqual(["c", "a", "b"]);
  });
});
