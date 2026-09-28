import { describe, expect, it } from "bun:test";
import { buildModelChoices, sortModelsForPicker } from "./provider-picker";

const OPENROUTER_MODELS = [
  { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
  { id: "openrouter/fusion", displayName: "Fusion" },
  { id: "deepseek/deepseek-v4", displayName: "DeepSeek V4" },
  { id: "openrouter/auto", displayName: "Auto Router" },
  { id: "openai/gpt-5", displayName: "GPT-5" },
  { id: "openrouter/free", displayName: "Free Router" },
];

describe("sortModelsForPicker", () => {
  it("pins openrouter/free and openrouter/auto first, then remaining router models in catalog order, above plain models", () => {
    expect(
      sortModelsForPicker("openrouter", OPENROUTER_MODELS, (m) => m.id).map((m) => m.id),
    ).toEqual([
      "openrouter/free",
      "openrouter/auto",
      "openrouter/fusion",
      "anthropic/claude-sonnet-4-5",
      "deepseek/deepseek-v4",
      "openai/gpt-5",
    ]);
  });

  it("does not pin router ids under other providers", () => {
    const models = [{ id: "plain-model" }, { id: "openrouter/free" }];
    expect(sortModelsForPicker("mistral", models, (m) => m.id).map((m) => m.id)).toEqual([
      "plain-model",
      "openrouter/free",
    ]);
  });
});

describe("buildModelChoices", () => {
  it("sets context and price in columns and names capabilities as words", () => {
    const choices = buildModelChoices("openai", [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        supportsTools: true,
        isReasoningModel: true,
        ingestImage: true,
        contextWindow: 400_000,
        inputPricePerMillion: 1.25,
        outputPricePerMillion: 10,
      } as never,
      { id: "tiny", supportsTools: false, contextWindow: 8_000 } as never,
      {
        id: "local",
        supportsTools: true,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
      } as never,
    ]);
    expect(choices[0]).toEqual({
      name: "GPT-5",
      value: "gpt-5",
      description: "400k\t$1.25 / $10",
      tag: "reasoning vision",
    });
    expect(choices[1]).toEqual({
      name: "tiny",
      value: "tiny",
      description: "8k\tprice unknown",
      tag: "no tools",
    });
    expect(choices[2]?.description).toBe("\tfree");
    expect(choices[2]?.tag).toBeUndefined();
  });
});
