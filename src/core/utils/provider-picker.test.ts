import { describe, expect, it } from "bun:test";
import { AVAILABLE_PROVIDERS } from "@/core/constants/models";
import {
  PINNED_PROVIDERS_FOR_PICKER,
  canonicalizeProviderId,
  sortProvidersForPicker,
} from "./provider-picker";

describe("canonicalizeProviderId", () => {
  it("maps google to the gemini pin slot", () => {
    expect(canonicalizeProviderId("google")).toBe("gemini");
    expect(canonicalizeProviderId("Gemini")).toBe("gemini");
  });
});

describe("sortProvidersForPicker", () => {
  it("pins OpenAI, Anthropic, Gemini, OpenRouter, and Ollama in that order", () => {
    expect(PINNED_PROVIDERS_FOR_PICKER).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "ollama",
    ]);

    const shuffled = [
      "ollama",
      "xai",
      "openrouter",
      "gemini",
      "alibaba",
      "anthropic",
      "openai",
    ] as const;

    expect(sortProvidersForPicker(shuffled)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "ollama",
      "alibaba",
      "xai",
    ]);
  });

  it("sorts remaining providers alphabetically by display name", () => {
    const remaining = ["zhipuai", "xai", "ai_gateway", "llamacpp", "alibaba", "groq"] as const;

    expect(sortProvidersForPicker(remaining)).toEqual([
      "alibaba",
      "groq",
      "llamacpp",
      "ai_gateway",
      "xai",
      "zhipuai",
    ]);
  });

  it("ignores a (configured) suffix when sorting by display name", () => {
    const providers = [
      { id: "xai", label: "xAI (configured)" },
      { id: "alibaba", label: "Alibaba" },
      { id: "openai", label: "OpenAI (configured)" },
      { id: "groq", label: "Groq (configured)" },
    ];

    expect(
      sortProvidersForPicker(
        providers,
        (provider) => provider.id,
        (provider) => provider.label,
      ).map((provider) => provider.id),
    ).toEqual(["openai", "alibaba", "groq", "xai"]);
  });

  it("treats google as Gemini for pinning", () => {
    expect(sortProvidersForPicker(["xai", "google", "alibaba", "openai"])).toEqual([
      "openai",
      "google",
      "alibaba",
      "xai",
    ]);
  });

  it("still sorts unknown providers alphabetically", () => {
    const providers = [
      { id: "zeta-cloud", label: "Zeta Cloud (configured)" },
      { id: "openai", label: "OpenAI" },
      { id: "alpha-labs", label: "Alpha Labs" },
      { id: "mid-tier", label: "Mid Tier" },
    ];

    expect(
      sortProvidersForPicker(
        providers,
        (provider) => provider.id,
        (provider) => provider.label,
      ).map((provider) => provider.id),
    ).toEqual(["openai", "alpha-labs", "mid-tier", "zeta-cloud"]);
  });

  it("falls back to formatted ids when no display name is given", () => {
    expect(sortProvidersForPicker(["custom_omega", "custom_alpha", "anthropic"])).toEqual([
      "anthropic",
      "custom_alpha",
      "custom_omega",
    ]);
  });

  it("orders the full provider registry pin group then A–Z by display name", () => {
    expect(sortProvidersForPicker(AVAILABLE_PROVIDERS)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "ollama",
      "alibaba",
      "cerebras",
      "deepseek",
      "fireworks",
      "groq",
      "llamacpp",
      "minimax",
      "mistral",
      "moonshotai",
      "togetherai",
      "ai_gateway",
      "xai",
      "zhipuai",
    ]);
  });
});
