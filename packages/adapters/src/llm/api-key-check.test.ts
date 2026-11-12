/** Provider key probes distinguish invalid credentials from endpoint permissions. */
import { describe, expect, it } from "bun:test";
import { fakeFetch } from "../test-support/fakes";
import { checkApiKey } from "./api-key-check";

function answering(status: number): typeof fetch {
  return fakeFetch(async () => new Response("{}", { status }));
}

describe("checkApiKey", () => {
  it("accepts a key the provider lists models for", async () => {
    expect(await checkApiKey("openai", "sk-good", answering(200))).toBe("accepted");
  });

  it("rejects an unauthenticated key but leaves endpoint permissions to the real request", async () => {
    expect(await checkApiKey("anthropic", "sk-bad", answering(401))).toBe("rejected");
    expect(await checkApiKey("openai", "sk-restricted", answering(403))).toBe("permission-denied");
    expect(await checkApiKey("groq", "sk-restricted", answering(403))).toBe("permission-denied");
  });

  it("leaves the key unchecked on other statuses, network errors, and unknown providers", async () => {
    const failing = fakeFetch(async () => {
      throw new Error("offline");
    });
    expect(await checkApiKey("openai", "sk", answering(500))).toBe("unchecked");
    expect(await checkApiKey("openai", "sk", failing)).toBe("unchecked");
    expect(await checkApiKey("ollama", "sk", answering(401))).toBe("unchecked");
  });

  it("sends the key the way the provider expects it", async () => {
    const seen: Record<string, string>[] = [];
    const recording = fakeFetch(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("{}", { status: 200 });
    });
    await checkApiKey("openai", "sk-1", recording);
    await checkApiKey("anthropic", "sk-2", recording);
    expect(seen[0]?.["Authorization"]).toBe("Bearer sk-1");
    expect(seen[1]?.["x-api-key"]).toBe("sk-2");
  });
});
