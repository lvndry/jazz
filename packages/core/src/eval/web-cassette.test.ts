import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  installWebCassette,
  isBypassHost,
  localModelServerHosts,
  requestKey,
} from "./web-cassette";

const CASSETTE = "/tmp/jazz-eval-cassette-test.json";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isBypassHost", () => {
  it("bypasses LLM-provider and infra hosts (so the cassette never starves the model call)", () => {
    expect(isBypassHost("https://api.openai.com/v1/responses")).toBe(true);
    expect(isBypassHost("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(isBypassHost("https://generativelanguage.googleapis.com/v1")).toBe(true);
    expect(isBypassHost("https://models.dev/api.json")).toBe(true);
  });
  /**
   * The regression: hosts were matched by substring, and every localhost port was let
   * through, so a page on an unrelated domain, or the user's own daemon, reached the network.
   */
  it("matches provider domains exactly and lets no local port through on its own", () => {
    expect(isBypassHost("https://max.ai.example.com/page")).toBe(false);
    expect(isBypassHost("https://notopenai.com/article")).toBe(false);
    expect(isBypassHost("http://localhost:4747/goals")).toBe(false);
    expect(isBypassHost("http://127.0.0.1:11434/api/chat", ["127.0.0.1:11434"])).toBe(true);
  });
  it("does not bypass genuine web-tool hosts", () => {
    expect(isBypassHost("https://example.com/article")).toBe(false);
    expect(isBypassHost("https://en.wikipedia.org/wiki/Recursion")).toBe(false);
  });
});

describe("localModelServerHosts", () => {
  /**
   * The regression: a vLLM server on a private-network address was not on the fixed host
   * list, so replay intercepted the model call itself and every eval sample timed out.
   */
  it("collects configured and environment model-server hosts so replay lets them through", () => {
    const jazzHome = mkdtempSync(join(tmpdir(), "cassette-home-"));
    try {
      writeFileSync(
        join(jazzHome, "config.json"),
        JSON.stringify({ llm: { vllm: { base_url: "http://100.85.157.126:8090/v1" } } }),
      );

      const hosts = localModelServerHosts(jazzHome, { SGLANG_BASE_URL: "gpu-box:30000" });

      expect(hosts).toContain("100.85.157.126:8090");
      expect(hosts).toContain("gpu-box:30000");
      expect(isBypassHost("http://100.85.157.126:8090/v1/chat/completions", hosts)).toBe(true);
      expect(isBypassHost("http://100.85.157.126:9000/page", hosts)).toBe(false);
      expect(isBypassHost("https://example.com/article", hosts)).toBe(false);
    } finally {
      rmSync(jazzHome, { recursive: true, force: true });
    }
  });

  it("falls back to each local server's default address", () => {
    expect(localModelServerHosts(join(tmpdir(), "no-such-jazz-home"), {}).sort()).toEqual([
      "127.0.0.1:11434",
      "127.0.0.1:30000",
      "127.0.0.1:8000",
      "127.0.0.1:8080",
    ]);
  });
});

describe("web-cassette", () => {
  it("requestKey is stable across identical requests", () => {
    expect(requestKey("https://x/y", { method: "GET" })).toBe(
      requestKey("https://x/y", { method: "GET" }),
    );
  });

  it("replay returns the recorded body without hitting the network", async () => {
    await fs.writeFile(
      CASSETTE,
      JSON.stringify({
        [requestKey("https://example.com/api", { method: "GET" })]: {
          status: 200,
          body: '{"hello":"world"}',
          headers: { "content-type": "application/json" },
        },
      }),
    );
    installWebCassette(CASSETTE, "replay");
    const res = await fetch("https://example.com/api", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("replay throws on an unrecorded request (no silent network)", async () => {
    await fs.writeFile(CASSETTE, JSON.stringify({}));
    installWebCassette(CASSETTE, "replay");
    await expect(fetch("https://unrecorded.com", { method: "GET" })).rejects.toThrow();
  });
});
