import { afterEach, describe, expect, it } from "bun:test";
import { llmFetch } from "./llm-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("llmFetch", () => {
  it("opts out of Bun's 300-second fetch timeout and keeps the caller's options", async () => {
    let seen: (RequestInit & { timeout?: boolean }) | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as typeof fetch;
    const controller = new AbortController();

    await llmFetch("https://llm.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    expect(seen?.timeout).toBe(false);
    expect(seen?.method).toBe("POST");
    expect(seen?.body).toBe("{}");
    expect(seen?.signal).toBe(controller.signal);
  });
});
