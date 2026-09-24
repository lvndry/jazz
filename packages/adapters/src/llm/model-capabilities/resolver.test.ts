import type { ProviderName } from "@jazz/core/constants/models";
import type { ReasoningControlSurface } from "@jazz/core/types/model-capabilities";
import { describe, expect, test } from "bun:test";
import { type ModelCapabilityRegistry } from "./registry";
import { resolveModelCapabilities } from "./resolver";

const effort: ReasoningControlSurface = {
  kind: "effort",
  efforts: ["low", "high"],
  canDisable: true,
  transport: "openai.responses.reasoning-effort",
};

const registry = {
  openai: {
    default: { supportsTools: false },
    models: { "model-a": { reasoning: effort, supportsTools: true } },
  },
} as const satisfies ModelCapabilityRegistry;

function resolve(
  input: Omit<Parameters<typeof resolveModelCapabilities>[0], "provider" | "registry">,
) {
  return resolveModelCapabilities({ provider: "openai" as ProviderName, registry, ...input });
}

describe("resolveModelCapabilities", () => {
  test("applies sources independently and preserves their provenance", () => {
    const result = resolve({
      modelId: "model-a",
      catalog: { supportsReasoning: false, supportsTools: false },
      live: { supportsTools: false },
    });

    expect(result.reasoning).toEqual(effort);
    expect(result.supportsTools).toBe(false);
    expect(result.source).toEqual({ reasoning: "builtin-model", tools: "live" });
  });

  test("uses exact model IDs and never applies another model's controls", () => {
    const result = resolve({
      modelId: "model-a:latest",
      catalog: { supportsReasoning: true, supportsTools: true },
    });

    expect(result.reasoning).toEqual({ kind: "unknown" });
    expect(result.supportsTools).toBe(false);
    expect(result.source).toEqual({ reasoning: "catalog", tools: "provider-default" });
  });

  test("operator overrides win over live, builtin, default, and catalog", () => {
    const result = resolve({
      modelId: "model-a",
      catalog: { supportsReasoning: false, supportsTools: false },
      live: {
        reasoning: {
          kind: "effort",
          efforts: ["medium"],
          canDisable: true,
          transport: "openai.responses.reasoning-effort",
        },
        supportsTools: false,
      },
      operator: {
        reasoning: {
          kind: "effort",
          efforts: ["xhigh"],
          canDisable: true,
          transport: "openai.responses.reasoning-effort",
        },
        supportsTools: true,
      },
    });

    expect(result.reasoning).toMatchObject({ kind: "effort", efforts: ["xhigh"] });
    expect(result.supportsTools).toBe(true);
    expect(result.source).toEqual({ reasoning: "operator", tools: "operator" });
  });

  test("allows an operator to explicitly mark an otherwise-known control unsupported", () => {
    const result = resolve({
      modelId: "model-a",
      operator: { reasoning: { kind: "unsupported" } },
    });

    expect(result.reasoning).toEqual({ kind: "unsupported" });
    expect(result.source.reasoning).toBe("operator");
  });

  test("rejects a closed transport that does not belong to the selected provider", () => {
    const result = resolve({
      modelId: "unknown",
      catalog: { supportsReasoning: false },
      operator: {
        reasoning: {
          kind: "toggle",
          canDisable: true,
          transport: "ollama.chat.think",
        },
      },
    });

    expect(result.reasoning).toEqual({ kind: "unsupported" });
    expect(result.source.reasoning).toBe("catalog");
  });

  test("returns unknown rather than unsupported when no source makes a claim", () => {
    const result = resolve({ modelId: "unknown" });

    expect(result.reasoning).toEqual({ kind: "unknown" });
    expect(result.supportsTools).toBe(false);
    expect(result.source).toEqual({ reasoning: "unknown", tools: "provider-default" });
  });
});
