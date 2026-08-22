import { describe, expect, it } from "bun:test";
import {
  buildOllamaContextChoices,
  defaultOllamaContextWindow,
  isOllamaCloudModel,
} from "./ollama";

describe("buildOllamaContextChoices", () => {
  it("offers the full ladder when the model context is unknown", () => {
    const values = buildOllamaContextChoices().map((choice) => choice.value);
    expect(values).toEqual([4096, 8192, 16384, 32768, 65536, 131072]);
  });

  it("caps choices to the model's detected context window", () => {
    const values = buildOllamaContextChoices(32768).map((choice) => choice.value);
    expect(values).toEqual([4096, 8192, 16384, 32768]);
    expect(values).not.toContain(65536);
  });

  it("appends the exact model maximum when it falls between ladder rungs", () => {
    const values = buildOllamaContextChoices(40960).map((choice) => choice.value);
    expect(values).toEqual([4096, 8192, 16384, 32768, 40960]);
    expect(buildOllamaContextChoices(40960).at(-1)?.name).toContain("model maximum");
  });

  it("always offers at least one choice for a tiny context window", () => {
    const values = buildOllamaContextChoices(2048).map((choice) => choice.value);
    expect(values).toEqual([2048]);
  });
});

describe("isOllamaCloudModel", () => {
  it("recognizes the :cloud tag and tags that end in -cloud", () => {
    expect(isOllamaCloudModel("kimi-k3:cloud")).toBe(true);
    expect(isOllamaCloudModel("gpt-oss:120b-cloud")).toBe(true);
    expect(isOllamaCloudModel("kimi-k3:CLOUD")).toBe(true);
  });

  it("rejects local tags and bare names", () => {
    expect(isOllamaCloudModel("llama3.2")).toBe(false);
    expect(isOllamaCloudModel("llama3.2:latest")).toBe(false);
    expect(isOllamaCloudModel("cloud")).toBe(false);
  });
});

describe("defaultOllamaContextWindow", () => {
  it("prefers 32K when the model can accommodate it", () => {
    expect(defaultOllamaContextWindow(131072)).toBe(32768);
    expect(defaultOllamaContextWindow()).toBe(32768);
  });

  it("clamps to the model maximum when smaller than the preferred default", () => {
    expect(defaultOllamaContextWindow(8192)).toBe(8192);
    expect(defaultOllamaContextWindow(6000)).toBe(6000);
  });

  it("always coincides with an offered choice", () => {
    for (const detected of [undefined, 2048, 6000, 8192, 40960, 131072, 200000]) {
      const choices = buildOllamaContextChoices(detected).map((choice) => choice.value);
      expect(choices).toContain(defaultOllamaContextWindow(detected));
    }
  });
});
