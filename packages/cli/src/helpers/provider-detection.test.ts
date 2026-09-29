/** Provider setup detection without reading credentials or requiring a running local server. */
import { describe, expect, it } from "bun:test";
import {
  environmentKeyDetections,
  ollamaOrigin,
  probeOllamaModels,
  type ProbeFetch,
} from "./provider-detection";

describe("first-run detection", () => {
  it("reports provider keys exported in the environment by variable name", () => {
    const detections = environmentKeyDetections({ OPENAI_API_KEY: "sk-test", EMPTY: "" });
    expect(detections).toContainEqual({ label: "OPENAI_API_KEY", detail: "in your environment" });
    expect(environmentKeyDetections({ OPENAI_API_KEY: "   " })).toEqual([]);
  });

  it("probes the configured Ollama origin and counts its models", async () => {
    const requested: string[] = [];
    const fake: ProbeFetch = async (url) => {
      requested.push(url);
      return new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
    };
    expect(await probeOllamaModels(ollamaOrigin("http://10.0.0.5:11434/v1"), fake)).toBe(3);
    expect(requested).toEqual(["http://10.0.0.5:11434/api/tags"]);
  });

  it("treats a server that does not answer as not running", async () => {
    const failing: ProbeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await probeOllamaModels(ollamaOrigin(undefined), failing)).toBeUndefined();
    expect(ollamaOrigin("not a url")).toBe("http://127.0.0.1:11434");
  });
});
