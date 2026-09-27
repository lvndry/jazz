import { describe, expect, it } from "bun:test";
import { checkApiKey } from "./api-key-check";

function answering(status: number): typeof fetch {
  return (async () => new Response("{}", { status })) as unknown as typeof fetch;
}

describe("checkApiKey", () => {
  it("accepts a key the provider lists models for", async () => {
    expect(await checkApiKey("openai", "sk-good", answering(200))).toBe("accepted");
  });

  it("rejects a key the provider answers 401 or 403 for", async () => {
    expect(await checkApiKey("anthropic", "sk-bad", answering(401))).toBe("rejected");
    expect(await checkApiKey("groq", "sk-bad", answering(403))).toBe("rejected");
  });

  it("leaves the key unchecked on other statuses, network errors, and unknown providers", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await checkApiKey("openai", "sk", answering(500))).toBe("unchecked");
    expect(await checkApiKey("openai", "sk", failing)).toBe("unchecked");
    expect(await checkApiKey("ollama", "sk", answering(401))).toBe("unchecked");
  });

  it("sends the key the way the provider expects it", async () => {
    const seen: Record<string, string>[] = [];
    const recording = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await checkApiKey("openai", "sk-1", recording);
    await checkApiKey("anthropic", "sk-2", recording);
    expect(seen[0]?.["Authorization"]).toBe("Bearer sk-1");
    expect(seen[1]?.["x-api-key"]).toBe("sk-2");
  });
});
