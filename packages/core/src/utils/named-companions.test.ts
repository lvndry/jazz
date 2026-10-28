import { describe, expect, it } from "bun:test";
import { isCompanionBinding, isCompanionName, resolveCompanionBinding } from "./named-companions";

const ocr = {
  provider: "vllm" as const,
  model: "paddleocr-vl-1.6",
  base_url: "http://ocr.internal:8150/v1",
  api_key: "ocr-key",
  accepts: ["image" as const],
  prompt: "OCR:",
};

describe("companion binding syntax", () => {
  it("accepts provider/model ids and plain names", () => {
    expect(isCompanionBinding("openai/gpt-5")).toBe(true);
    expect(isCompanionBinding("ocr")).toBe(true);
    expect(isCompanionBinding("ocr_2")).toBe(true);
  });

  it("refuses names that could not be a config path segment or an env var suffix", () => {
    expect(isCompanionName("doc.ocr")).toBe(false);
    expect(isCompanionName("nope/model")).toBe(false);
    expect(isCompanionName("-ocr")).toBe(false);
    expect(isCompanionName("")).toBe(false);
    expect(isCompanionBinding("nope/some-model")).toBe(false);
  });
});

describe("resolveCompanionBinding", () => {
  it("runs a provider/model id on its own, ignoring definitions", () => {
    const resolution = resolveCompanionBinding("openai/gpt-5", { ocr: ocr });
    expect(resolution).toEqual({
      ok: true,
      target: { binding: "openai/gpt-5", provider: "openai", model: "gpt-5" },
    });
  });

  it("carries everything a named definition adds", () => {
    expect(resolveCompanionBinding("ocr", { ocr: ocr })).toEqual({
      ok: true,
      target: {
        binding: "ocr",
        provider: "vllm",
        model: "paddleocr-vl-1.6",
        baseUrl: "http://ocr.internal:8150/v1",
        apiKey: "ocr-key",
        accepts: ["image"],
        prompt: "OCR:",
      },
    });
  });

  it("says where to define a name that is not defined", () => {
    const resolution = resolveCompanionBinding("ocr", undefined);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('No companion named "ocr"');
      expect(resolution.error).toContain("~/.jazz/config.json");
    }
  });

  it("never resolves a name through the object prototype", () => {
    expect(resolveCompanionBinding("constructor", {}).ok).toBe(false);
    expect(resolveCompanionBinding("toString", { ocr: ocr }).ok).toBe(false);
  });
});
