import { describe, expect, it, mock } from "bun:test";
import type { Agent } from "@/core/types/agent";
import type { ModelsDevMetadata } from "@/core/utils/models-dev";

const metadataByModel = new Map<string, ModelsDevMetadata>();
const providerEntries = new Map<string, unknown[]>();

mock.module("@/core/utils/models-dev", () => ({
  getModelsDevMetadata: (model: string) => Promise.resolve(metadataByModel.get(model)),
  getModelsDevProviderModels: (provider: string) =>
    Promise.resolve(providerEntries.get(provider) ?? []),
}));

const { findAgentsWithCapability, isMediaCapability, suggestModelsForCapability } =
  await import("./media-agents");

function metadata(overrides: Partial<ModelsDevMetadata> = {}): ModelsDevMetadata {
  return {
    contextWindow: 128_000,
    supportsTools: false,
    isReasoningModel: false,
    supportsVision: false,
    supportsPdf: false,
    supportsAudio: false,
    supportsVideo: false,
    generatesImage: false,
    generatesAudio: false,
    generatesVideo: false,
    supportsTemperature: true,
    ...overrides,
  };
}

function agent(name: string, model: Agent["model"]): Agent {
  return {
    id: name,
    name,
    model,
    config: { persona: "default", llmProvider: "openai", llmModel: model },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("isMediaCapability", () => {
  it("accepts the three media kinds and nothing else", () => {
    expect(isMediaCapability("image")).toBe(true);
    expect(isMediaCapability("audio")).toBe(true);
    expect(isMediaCapability("video")).toBe(true);
    expect(isMediaCapability("spreadsheet")).toBe(false);
  });
});

describe("findAgentsWithCapability", () => {
  it("keeps only agents whose model produces that media", async () => {
    metadataByModel.set("gpt-image-1.5", metadata({ generatesImage: true }));
    metadataByModel.set("claude-sonnet-5", metadata());

    const found = await findAgentsWithCapability(
      [agent("artist", "openai/gpt-image-1.5"), agent("writer", "anthropic/claude-sonnet-5")],
      "image",
    );

    expect(found.map((entry) => entry.agent.name)).toEqual(["artist"]);
  });

  it("reports whether the agent can also use tools", async () => {
    // The difference between an agent that draws and works, and one that only draws — most
    // image models report tool_call: false.
    metadataByModel.set("draw-only", metadata({ generatesImage: true }));
    metadataByModel.set("draw-and-work", metadata({ generatesImage: true, supportsTools: true }));

    const found = await findAgentsWithCapability(
      [agent("a", "gemini/draw-only"), agent("b", "gemini/draw-and-work")],
      "image",
    );

    expect(found.find((entry) => entry.agent.name === "a")?.supportsTools).toBe(false);
    expect(found.find((entry) => entry.agent.name === "b")?.supportsTools).toBe(true);
  });

  it("does not confuse one modality for another", async () => {
    metadataByModel.set("speaker", metadata({ generatesAudio: true }));
    expect(await findAgentsWithCapability([agent("s", "gemini/speaker")], "image")).toEqual([]);
    expect(await findAgentsWithCapability([agent("s", "gemini/speaker")], "audio")).toHaveLength(1);
  });

  it("skips agents whose model id cannot be parsed or is unknown", async () => {
    // An unknown model reads the same as "cannot", which is the safe direction: claiming an
    // agent can generate when it cannot sends the user down a dead end.
    expect(
      await findAgentsWithCapability([agent("weird", "not-a-model-id" as Agent["model"])], "image"),
    ).toEqual([]);
    expect(
      await findAgentsWithCapability([agent("x", "openai/never-heard-of-it")], "image"),
    ).toEqual([]);
  });
});

describe("suggestModelsForCapability", () => {
  function entry(id: string, meta: ModelsDevMetadata) {
    return {
      id,
      displayName: id,
      inputModalities: ["text"],
      outputModalities: ["text", "image"],
      metadata: meta,
    };
  }

  it("ranks tool-capable models first", async () => {
    // An agent that can only generate is much narrower than one that can also do the work.
    providerEntries.set("openai", [
      entry("no-tools", metadata({ generatesImage: true })),
      entry("with-tools", metadata({ generatesImage: true, supportsTools: true })),
    ]);

    const suggestions = await suggestModelsForCapability("image", ["openai"]);
    expect(suggestions[0]?.id).toBe("with-tools");
  });

  it("skips OpenRouter routers, which only might reach a capable model", async () => {
    providerEntries.set("openrouter", [
      entry("openrouter/auto", metadata({ generatesImage: true, supportsTools: true })),
      entry("google/gemini-3-pro-image", metadata({ generatesImage: true })),
    ]);

    const ids = (await suggestModelsForCapability("image", ["openrouter"])).map((s) => s.id);
    expect(ids).not.toContain("openrouter/auto");
    expect(ids).toContain("google/gemini-3-pro-image");
  });

  it("skips models jazz would not let you select as an agent", async () => {
    // A pure generator returns no text, so it cannot be an agent however well it draws.
    providerEntries.set("openai", [
      {
        id: "pure-generator",
        displayName: "pure",
        inputModalities: ["text"],
        outputModalities: ["image"],
        metadata: metadata({ generatesImage: true }),
      },
    ]);

    expect(await suggestModelsForCapability("image", ["openai"])).toEqual([]);
  });

  it("is empty when a provider has nothing for that capability", async () => {
    providerEntries.set("anthropic", [entry("claude", metadata())]);
    expect(await suggestModelsForCapability("image", ["anthropic"])).toEqual([]);
  });
});
