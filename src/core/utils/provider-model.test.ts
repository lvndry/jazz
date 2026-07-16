import { describe, expect, it } from "bun:test";
import { parseProviderModel } from "./provider-model";

describe("parseProviderModel", () => {
  it("parses a simple provider/model pair", () => {
    expect(parseProviderModel("anthropic/claude-3-5-haiku-latest")).toEqual({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
    });
  });

  it("splits on the first slash so slash-bearing model ids survive", () => {
    expect(parseProviderModel("openrouter/anthropic/claude-3.5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseProviderModel("  openai/gpt-4  ")).toEqual({
      provider: "openai",
      model: "gpt-4",
    });
  });

  it("returns null when there is no slash", () => {
    expect(parseProviderModel("gpt-4")).toBeNull();
  });

  it("returns null when the model segment is empty", () => {
    expect(parseProviderModel("anthropic/")).toBeNull();
  });

  it("returns null when the provider segment is empty", () => {
    expect(parseProviderModel("/gpt-4")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseProviderModel("")).toBeNull();
  });

  it("returns null when the provider is not a known provider", () => {
    expect(parseProviderModel("notaprovider/some-model")).toBeNull();
  });
});
