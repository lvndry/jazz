import { describe, expect, it } from "bun:test";
import { sortModelsForPicker } from "@/core/utils/provider-picker";

describe("sortModelsForPicker", () => {
  const toModels = (...list: string[]): { id: string }[] => list.map((id) => ({ id }));
  const order = (providerId: string, models: readonly { id: string }[]): string[] =>
    sortModelsForPicker(providerId, models, (model) => model.id).map((model) => model.id);

  it("lifts the OpenRouter gateway models to the top, free before auto", () => {
    const models = toModels(
      "anthropic/claude-sonnet-4-5",
      "openrouter/auto",
      "z-ai/glm-5.2:free",
      "openrouter/free",
    );

    expect(order("openrouter", models)).toEqual([
      "openrouter/free",
      "openrouter/auto",
      "anthropic/claude-sonnet-4-5",
      "z-ai/glm-5.2:free",
    ]);
  });

  it("keeps catalog order for everything that is not pinned", () => {
    const models = toModels("zeta", "alpha", "openrouter/free", "mid");

    expect(order("openrouter", models)).toEqual(["openrouter/free", "zeta", "alpha", "mid"]);
  });

  it("leaves providers without pinned models untouched", () => {
    const models = toModels("gpt-5-mini", "gpt-5", "o3");

    expect(order("openai", models)).toEqual(["gpt-5-mini", "gpt-5", "o3"]);
  });

  it("ignores a pinned id the catalog does not offer", () => {
    const models = toModels("openrouter/auto", "meta/llama-4");

    expect(order("openrouter", models)).toEqual(["openrouter/auto", "meta/llama-4"]);
  });
});
