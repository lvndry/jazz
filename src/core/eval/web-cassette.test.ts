import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { installWebCassette, isBypassHost, requestKey } from "./web-cassette";

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
    expect(isBypassHost("http://localhost:11434/api/chat")).toBe(true);
    expect(isBypassHost("https://models.dev/api.json")).toBe(true);
  });
  it("does not bypass genuine web-tool hosts", () => {
    expect(isBypassHost("https://example.com/article")).toBe(false);
    expect(isBypassHost("https://en.wikipedia.org/wiki/Recursion")).toBe(false);
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
