import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { installWebCassette, requestKey } from "./web-cassette";

const CASSETTE = "/tmp/jazz-eval-cassette-test.json";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
