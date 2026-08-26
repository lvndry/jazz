import { describe, expect, it } from "bun:test";
import { buildModelChoices, sortModelsForPicker } from "./provider-picker";

const OPENROUTER_MODELS = [
  { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
  { id: "openrouter/fusion", displayName: "Fusion" },
  { id: "deepseek/deepseek-v4", displayName: "DeepSeek V4" },
  { id: "openrouter/auto", displayName: "Auto Router" },
  { id: "openai/gpt-5", displayName: "GPT-5" },
  { id: "openrouter/free", displayName: "Free Router" },
] as never[];

describe("sortModelsForPicker", () => {
  it("pins every openrouter/* router model above plain models, in catalog order", () => {
    expect(
      sortModelsForPicker("openrouter", OPENROUTER_MODELS, (m) => m.id).map((m) => m.id),
    ).toEqual([
      "openrouter/fusion",
      "openrouter/auto",
      "openrouter/free",
      "anthropic/claude-sonnet-4-5",
      "deepseek/deepseek-v4",
      "openai/gpt-5",
    ]);
  });

  it("does not pin router ids under other providers", () => {
    const models = [{ id: "plain-model" }, { id: "openrouter/free" }] as never[];
    expect(sortModelsForPicker("mistral", models, (m) => m.id).map((m) => m.id)).toEqual([
      "plain-model",
      "openrouter/free",
    ]);
  });
});

describe("buildModelChoices", () => {
  it("renders one row per model with a capability description", () => {
    const choices = buildModelChoices("openai", [
      { id: "gpt-5", displayName: "GPT-5", supportsTools: true } as never,
    ]);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.name).toBe("GPT-5");
    expect(choices[0]?.value).toBe("gpt-5");
    expect(choices[0]?.description).toContain("txt");
    expect(choices[0]?.description).toContain("→");
  });
});
