import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@/core/types/llm";
import {
  companionRole,
  COMPANION_ROLES,
  describeModelCapabilities,
  describeRole,
  filterCapableModels,
  formatModelPriceLine,
  isCompanionRole,
  isMediaModality,
  modelSupportsRole,
} from "./model-capabilities";

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return { supportsTools: true, ...overrides };
}

describe("filterCapableModels", () => {
  it("keeps only models whose flags cover the role", () => {
    const models = [
      model({ id: "vision-model", ingestImage: true }),
      model({ id: "text-only" }),
      model({ id: "audio-model", ingestAudio: true }),
    ];

    const vision = filterCapableModels(models, "analyze:image");
    expect(vision.map((m) => m.modelId)).toEqual(["vision-model"]);

    const audio = filterCapableModels(models, "analyze:audio");
    expect(audio.map((m) => m.modelId)).toEqual(["audio-model"]);
  });

  it("treats an absent flag as no", () => {
    expect(modelSupportsRole(model({ id: "x" }), "analyze:video")).toBe(false);
    expect(modelSupportsRole(model({ id: "x", ingestVideo: false }), "analyze:video")).toBe(false);
    expect(modelSupportsRole(model({ id: "x", ingestVideo: true }), "analyze:video")).toBe(true);
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

    expect(filterCapableModels(models, "analyze:image").map((m) => m.modelId)).toEqual([
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

describe("role vocabulary", () => {
  it("reads the two flags of the same modality independently", () => {
    const ingestOnly = model({ id: "eyes", ingestImage: true });
    expect(modelSupportsRole(ingestOnly, "analyze:image")).toBe(true);
    expect(modelSupportsRole(ingestOnly, "generate:image")).toBe(false);

    const generateOnly = model({ id: "brush", generatesImage: true });
    expect(modelSupportsRole(generateOnly, "analyze:image")).toBe(false);
    expect(modelSupportsRole(generateOnly, "generate:image")).toBe(true);
  });

  it("covers every action-modality pair exactly once", () => {
    expect(COMPANION_ROLES).toEqual([
      "analyze:image",
      "analyze:audio",
      "analyze:video",
      "generate:image",
      "generate:audio",
      "generate:video",
    ]);
    expect(new Set(COMPANION_ROLES).size).toBe(COMPANION_ROLES.length);
  });

  it("builds roles from their two axes", () => {
    expect(companionRole("generate", "video")).toBe("generate:video");
    expect(isCompanionRole("generate:video")).toBe(true);
    expect(isCompanionRole("video")).toBe(false);
  });

  it("rejects non-modalities like pdf", () => {
    expect(isMediaModality("pdf")).toBe(false);
    expect(isMediaModality("image")).toBe(true);
  });

  it("says what each role does in words", () => {
    expect(describeRole("analyze:image")).toBe("image understanding");
    expect(describeRole("generate:audio")).toBe("audio generation");
  });
});

describe("describeModelCapabilities", () => {
  it("puts inputs, arrow, outputs — each side with its own price", () => {
    expect(
      describeModelCapabilities(
        model({
          id: "x",
          ingestImage: true,
          ingestPdf: true,
          inputPricePerMillion: 3,
          outputPricePerMillion: 15,
        }),
      ),
    ).toBe("txt·img·pdf $3/M → txt $15/M");
  });

  it("shows generated media on the output side", () => {
    expect(
      describeModelCapabilities(
        model({
          id: "x",
          generatesImage: true,
          generatesAudio: true,
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
        }),
      ),
    ).toBe("txt $0/M → txt·img·aud $0/M");
  });

  it("marks an unpriced side with ? rather than pretending it is free", () => {
    expect(describeModelCapabilities(model({ id: "x" }))).toBe("txt ?/M → txt ?/M");
    expect(describeModelCapabilities(model({ id: "x", inputPricePerMillion: 1.25 }))).toBe(
      "txt $1.25/M → txt ?/M",
    );
  });
});
