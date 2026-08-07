import { describe, expect, it } from "bun:test";
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
