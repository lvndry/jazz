import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@/core/types/llm";
import {
  attachmentKindForCapability,
  describeModelCapabilities,
  filterCapableModels,
  formatModelPriceLine,
  isPerceptionCapability,
  modelHasCapability,
} from "./model-capabilities";

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return { supportsTools: true, ...overrides };
}

describe("filterCapableModels", () => {
  it("keeps only models whose ingest flags cover the capability", () => {
    const models = [
      model({ id: "vision-model", ingestImage: true }),
      model({ id: "text-only" }),
      model({ id: "audio-model", ingestAudio: true }),
    ];

    const vision = filterCapableModels(models, "vision");
    expect(vision.map((m) => m.modelId)).toEqual(["vision-model"]);

    const audio = filterCapableModels(models, "audio");
    expect(audio.map((m) => m.modelId)).toEqual(["audio-model"]);
  });

  it("treats an absent flag as no", () => {
    expect(modelHasCapability(model({ id: "x" }), "video")).toBe(false);
    expect(modelHasCapability(model({ id: "x", ingestVideo: false }), "video")).toBe(false);
    expect(modelHasCapability(model({ id: "x", ingestVideo: true }), "video")).toBe(true);
  });

  it("sorts priced before unpriced, then by input price", () => {
    const models = [
      model({ id: "unpriced-vision", ingestImage: true }),
      model({
        id: "expensive",
        ingestImage: true,
        inputPricePerMillion: 15,
        outputPricePerMillion: 75,
      }),
      model({ id: "cheap", ingestImage: true, inputPricePerMillion: 3, outputPricePerMillion: 15 }),
    ];

    expect(filterCapableModels(models, "vision").map((m) => m.modelId)).toEqual([
      "cheap",
      "expensive",
      "unpriced-vision",
    ]);
  });
});

describe("formatModelPriceLine", () => {
  it("says unknown rather than fabricating $0 when the catalog has no price", () => {
    expect(formatModelPriceLine({})).toBe("price unknown");
  });

  it("formats whichever sides are known", () => {
    expect(formatModelPriceLine({ inputPricePerMillion: 3, outputPricePerMillion: 15 })).toBe(
      "$3/M in · $15/M out",
    );
    expect(formatModelPriceLine({ outputPricePerMillion: 7.5 })).toBe("$7.5/M out");
    expect(formatModelPriceLine({ inputPricePerMillion: 0 })).toBe("$0/M in");
  });
});

describe("capability vocabulary", () => {
  it("maps capabilities to the attachment kinds delegation carries", () => {
    expect(attachmentKindForCapability("vision")).toBe("image");
    expect(attachmentKindForCapability("audio")).toBe("audio");
    expect(attachmentKindForCapability("video")).toBe("video");
  });

  it("rejects non-capabilities like pdf", () => {
    expect(isPerceptionCapability("pdf")).toBe(false);
    expect(isPerceptionCapability("vision")).toBe(true);
  });
});

describe("describeModelCapabilities", () => {
  it("reads text-only as explicit, never blank", () => {
    expect(describeModelCapabilities(model({ id: "x" }))).toBe("text · price unknown");
  });

  it("lists input modalities, generation, and price", () => {
    expect(
      describeModelCapabilities(
        model({
          id: "x",
          ingestImage: true,
          ingestPdf: true,
          generatesImage: true,
          inputPricePerMillion: 3,
          outputPricePerMillion: 15,
        }),
      ),
    ).toBe("img·pdf · gen img · $3/M in · $15/M out");
  });
});
