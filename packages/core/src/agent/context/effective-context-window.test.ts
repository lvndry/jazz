import { describe, expect, it } from "bun:test";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import {
  describeContextWindowShortfall,
  resolveEffectiveContextWindow,
} from "./effective-context-window";

describe("resolveEffectiveContextWindow", () => {
  it("accounts against the pinned num_ctx, not the model maximum", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      modelMaxTokens: 262144,
      pinnedContextWindow: 131072,
    });

    expect(effective.tokens).toBe(131072);
    expect(effective.source).toBe("pinned");
    expect(effective.modelMaxTokens).toBe(262144);
  });

  it("accounts against the window the local server reported when none is pinned", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "llamacpp",
      modelMaxTokens: 262144,
      serverContextWindow: 32768,
    });

    expect(effective.tokens).toBe(32768);
    expect(effective.source).toBe("server");
  });

  it("prefers the pinned window over the one the server currently reports", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      modelMaxTokens: 262144,
      pinnedContextWindow: 65536,
      serverContextWindow: 131072,
    });

    expect(effective.tokens).toBe(65536);
  });

  it("never grants more context than the weights support", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      modelMaxTokens: 40960,
      pinnedContextWindow: 131072,
    });

    expect(effective.tokens).toBe(40960);
  });

  it("leaves cloud providers on their advertised window even if num_ctx leaked into the config", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "anthropic",
      modelMaxTokens: 200000,
      pinnedContextWindow: 8192,
    });

    expect(effective.tokens).toBe(200000);
    expect(effective.source).toBe("model-max");
  });

  it("trusts a pinned window larger than the placeholder when no maximum is known", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      pinnedContextWindow: 200000,
    });

    expect(effective.tokens).toBe(200000);
    expect(effective.source).toBe("pinned");
    expect(effective.modelMaxTokens).toBeUndefined();
  });

  it("trusts a server-reported window larger than the placeholder when no maximum is known", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "llamacpp",
      serverContextWindow: 200000,
    });

    expect(effective.tokens).toBe(200000);
  });

  it("falls back to the default window when nothing is known at all", () => {
    const effective = resolveEffectiveContextWindow({ provider: "ollama" });

    expect(effective.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(effective.source).toBe("fallback");
  });

  it("ignores a non-positive pinned window rather than starving the run", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      modelMaxTokens: 262144,
      pinnedContextWindow: 0,
    });

    expect(effective.tokens).toBe(262144);
    expect(effective.source).toBe("model-max");
  });
});

describe("describeContextWindowShortfall", () => {
  it("warns when a local agent has no pinned window", () => {
    const advice = describeContextWindowShortfall(
      "ollama",
      resolveEffectiveContextWindow({ provider: "ollama", modelMaxTokens: 262144 }),
    );

    expect(advice).toContain("262,144");
    expect(advice).toContain("jazz agent edit");
  });

  it("says the window is a guess when nothing reports the model's size", () => {
    const advice = describeContextWindowShortfall(
      "ollama",
      resolveEffectiveContextWindow({ provider: "ollama" }),
    );

    expect(advice).toContain("estimate");
    expect(advice).toContain("jazz agent edit");
  });

  it("stays quiet once a window is pinned", () => {
    const advice = describeContextWindowShortfall(
      "ollama",
      resolveEffectiveContextWindow({
        provider: "ollama",
        modelMaxTokens: 262144,
        pinnedContextWindow: 131072,
      }),
    );

    expect(advice).toBeNull();
  });

  it("stays quiet for cloud providers, whose advertised window is the real one", () => {
    const advice = describeContextWindowShortfall(
      "anthropic",
      resolveEffectiveContextWindow({ provider: "anthropic", modelMaxTokens: 200000 }),
    );

    expect(advice).toBeNull();
  });
});

describe("agent max context tokens", () => {
  it("lowers a cloud window to the agent's ceiling", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "anthropic",
      modelMaxTokens: 200000,
      agentMaxTokens: 60000,
    });

    expect(effective.tokens).toBe(60000);
    expect(effective.cappedByAgent).toBe(true);
    expect(effective.agentMaxTokens).toBe(60000);
    expect(effective.source).toBe("model-max");
    expect(effective.modelMaxTokens).toBe(200000);
  });

  it("never raises the window above what the runtime will honour", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "ollama",
      modelMaxTokens: 262144,
      pinnedContextWindow: 32768,
      agentMaxTokens: 131072,
    });

    expect(effective.tokens).toBe(32768);
    expect(effective.cappedByAgent).toBe(false);
    expect(effective.source).toBe("pinned");
  });

  it("ignores a non-positive ceiling", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "anthropic",
      modelMaxTokens: 200000,
      agentMaxTokens: 0,
    });

    expect(effective.tokens).toBe(200000);
    expect(effective.cappedByAgent).toBe(false);
    expect(effective.agentMaxTokens).toBeUndefined();
  });

  it("reports no cap when the agent ceiling is absent", () => {
    const effective = resolveEffectiveContextWindow({
      provider: "anthropic",
      modelMaxTokens: 200000,
    });

    expect(effective.cappedByAgent).toBe(false);
    expect(effective.agentMaxTokens).toBeUndefined();
  });

  it("still warns a local agent whose ceiling the server never promised", () => {
    const advice = describeContextWindowShortfall(
      "ollama",
      resolveEffectiveContextWindow({
        provider: "ollama",
        modelMaxTokens: 262144,
        agentMaxTokens: 32768,
      }),
    );

    expect(advice).toContain("max context (32,768 tokens)");
  });

  it("stays quiet when a pinned window is capped further by the agent", () => {
    const advice = describeContextWindowShortfall(
      "ollama",
      resolveEffectiveContextWindow({
        provider: "ollama",
        modelMaxTokens: 262144,
        pinnedContextWindow: 131072,
        agentMaxTokens: 32768,
      }),
    );

    expect(advice).toBeNull();
  });
});
