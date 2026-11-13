/** Verify replay rejects unintended providers and requires consent before sending private data remotely. */
import type { Agent } from "@jazz/core/types/agent";
import { describe, expect, test } from "bun:test";
import { assertVllmReplayProviders, validateVllmReplayEndpoint } from "./compaction-replay-safety";

function agent(
  provider: Agent["config"]["llm"]["provider"] = "vllm",
  summarizerModel?: string,
): Agent {
  return {
    id: "replay-agent",
    name: "Replay",
    config: {
      persona: "default",
      tools: [],
      llm: { provider, model: "primary-model", ...(summarizerModel ? { summarizerModel } : {}) },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("compaction replay providers", () => {
  test("accepts the primary vLLM model or a separately configured vLLM summarizer", () => {
    expect(() => assertVllmReplayProviders(agent())).not.toThrow();
    expect(() => assertVllmReplayProviders(agent("vllm", "vllm/summary-model"))).not.toThrow();
  });

  test("uses the production summarizer selection and rejects either non-vLLM provider", () => {
    expect(() => assertVllmReplayProviders(agent("vllm", "openai/gpt-4"))).toThrow(
      "both primary and summarizer",
    );
    expect(() => assertVllmReplayProviders(agent("openai", "vllm/summary-model"))).toThrow(
      "both primary and summarizer",
    );
    expect(() => assertVllmReplayProviders(agent("vllm", "invalid selection"))).not.toThrow();
  });
});

describe("compaction replay endpoint", () => {
  test.each([
    ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000"],
    ["https://127.255.255.254:8443/v1", "https://127.255.255.254:8443"],
    ["http://127.1:8000/v1", "http://127.0.0.1:8000"],
    ["http://2130706433:8000/v1", "http://127.0.0.1:8000"],
    ["http://0x7f000001:8000/v1", "http://127.0.0.1:8000"],
    ["http://0177.0.0.1:8000/v1", "http://127.0.0.1:8000"],
    ["http://[::1]:8000/v1", "http://[::1]:8000"],
    ["http://[0:0:0:0:0:0:0:1]:8000/v1", "http://[::1]:8000"],
  ])("accepts canonical loopback routing for %s", (endpoint, origin) => {
    expect(validateVllmReplayEndpoint(endpoint)).toEqual({ origin, isLoopback: true });
  });

  test.each([
    "https://inference.example/v1",
    "http://localhost:8000/v1",
    "http://127.attacker.example/v1",
    "http://127.0.0.1.attacker.example/v1",
    "http://192.168.1.20:8000/v1",
    "http://100.85.157.126:8090/v1",
    "http://0.0.0.0:8000/v1",
    "http://[::ffff:127.0.0.1]:8000/v1",
  ])("requires explicit remote consent for %s", (endpoint) => {
    expect(() => validateVllmReplayEndpoint(endpoint)).toThrow("--allow-remote");
    expect(validateVllmReplayEndpoint(endpoint, { allowRemote: true })).toEqual({
      origin: new URL(endpoint).origin,
      isLoopback: false,
    });
  });

  test.each([false, true])(
    "rejects malformed URLs, protocols and credentials with allowRemote=%s",
    (allowRemote) => {
      for (const endpoint of [
        "not a URL secret-value",
        "file:///private/secret-value",
        "ftp://127.0.0.1/secret-value",
        "http://user:secret-value@127.0.0.1:8000/v1",
        "https://user:secret-value@inference.example/v1",
      ]) {
        expect(() => validateVllmReplayEndpoint(endpoint, { allowRemote })).toThrow();
        try {
          validateVllmReplayEndpoint(endpoint, { allowRemote });
        } catch (error) {
          expect(String(error)).not.toContain("secret-value");
          expect(String(error)).not.toContain(endpoint);
        }
      }
    },
  );

  test("discloses only the remote origin, omitting path and query secrets", () => {
    expect(
      validateVllmReplayEndpoint("https://inference.example/private-token/v1?key=secret-value", {
        allowRemote: true,
      }),
    ).toEqual({ origin: "https://inference.example", isLoopback: false });
  });
});
