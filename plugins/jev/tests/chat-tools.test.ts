/** Exercises the classify and rank tools at the plugin boundary: what they send and what they return. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginToolRegistration, PluginToolResult } from "@jazz/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import plugin from "../src/index";
import { JEV_BASE_URL, JEV_MODEL } from "../src/jev-client";

const originalFetch = globalThis.fetch;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), "jev-chat-tools-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(workingDirectory, { recursive: true, force: true });
});

function registerTools(
  apiKey: string | undefined = "test-key",
): Map<string, PluginToolRegistration> {
  const tools = new Map<string, PluginToolRegistration>();
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: { register: () => {} },
    policy: { register: () => {} },
    decisions: {
      registerProvider: () => ({
        decide: () => Promise.reject(new Error("hooks are not under test")),
      }),
    },
    tools: { register: (registration) => tools.set(registration.name, registration) },
    commands: { register: () => {} },
    lifecycle: { register: () => {} },
    workspace: { register: () => {} },
    secrets: { get: async () => apiKey },
  };
  plugin.register(api);
  return tools;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  apiKey?: string,
): Promise<PluginToolResult> {
  const tool = registerTools(apiKey).get(name);
  if (tool === undefined) {
    throw new Error(`tool ${name} is not registered`);
  }
  return tool.handler(args, { signal: new AbortController().signal, cwd: workingDirectory });
}

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly imageParts: number;
}

function respondWith(answers: unknown): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.body instanceof FormData) {
      const request = init.body.get("request") as Blob;
      const imageParts = [...init.body.keys()].filter((key) => key.startsWith("image-")).length;
      requests.push({
        url: String(input),
        body: JSON.parse(await request.text()) as Record<string, unknown>,
        imageParts,
      });
    } else {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        imageParts: 0,
      });
    }
    return Response.json({
      model: JEV_MODEL,
      answers,
      usage: { input_tokens: 400, output_tokens: 6 },
    });
  }) as typeof fetch;
  return requests;
}

describe("classify", () => {
  it("asks one choice question per item in a single request and returns every label's probability", async () => {
    const requests = respondWith({
      item_1: {
        type: "choice",
        choice: "urgent",
        probabilities: { urgent: 0.9, newsletter: 0.1 },
        confidence: 0.88,
      },
      item_2: {
        type: "choice",
        choice: "newsletter",
        probabilities: { urgent: 0.05, newsletter: 0.95 },
        confidence: 0.94,
      },
    });
    const result = await call("classify", {
      items: ["Server down, customers affected", { text: "Weekly digest #42" }],
      labels: [{ name: "urgent", description: "Needs action today" }, "newsletter"],
      instructions: "by what the user needs to do with it",
      context: "The user runs a small SaaS.",
    });

    expect(result.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${JEV_BASE_URL}/systemone`);
    expect(requests[0]?.body).toMatchObject({
      model: JEV_MODEL,
      state: {
        context: "The user runs a small SaaS.",
        items: [
          { id: "item_1", text: "Server down, customers affected" },
          { id: "item_2", text: "Weekly digest #42" },
        ],
      },
      questions: {
        item_1: { type: "choice", criteria: { urgent: "Needs action today", newsletter: null } },
        item_2: { type: "choice", criteria: { urgent: "Needs action today", newsletter: null } },
      },
    });
    expect(JSON.parse(result.content)).toEqual({
      model: JEV_MODEL,
      results: [
        {
          item: 1,
          label: "urgent",
          probabilities: { urgent: 0.9, newsletter: 0.1 },
          confidence: 0.88,
        },
        {
          item: 2,
          label: "newsletter",
          probabilities: { urgent: 0.05, newsletter: 0.95 },
          confidence: 0.94,
        },
      ],
      usage: { inputTokens: 400, costUSD: (400 * 0.042) / 1_000_000 },
    });
  });

  it("sends an image item once, as an upload referenced from the item list", async () => {
    await writeFile(join(workingDirectory, "receipt.png"), PNG_BYTES);
    const requests = respondWith({
      item_1: {
        type: "choice",
        choice: "business",
        probabilities: { business: 0.7, personal: 0.3 },
        confidence: 0.6,
      },
    });
    const result = await call("classify", {
      items: [{ image: "receipt.png", text: "Dinner, 3 people" }],
      labels: ["business", "personal"],
    });

    expect(result.isError).toBeUndefined();
    expect(requests[0]?.imageParts).toBe(1);
    const body = requests[0]?.body as {
      state: unknown;
      assets: Record<string, { type: string; part: string }>;
    };
    const [reference] = Object.keys(body.assets);
    expect(reference).toMatch(/^image-/);
    expect(body.assets[reference ?? ""]).toEqual({ type: "image", part: "image-1" });
    expect(JSON.stringify(body.state).split(reference ?? "").length - 1).toBe(1);
  });

  it("rejects a file that is not a PNG or JPEG before calling Jev", async () => {
    await writeFile(join(workingDirectory, "notes.txt"), "plain text");
    const requests = respondWith({});
    const result = await call("classify", {
      items: [{ image: "notes.txt" }],
      labels: ["a", "b"],
    });
    expect(result).toEqual({ isError: true, content: "image notes.txt is not a PNG or JPEG file" });
    expect(requests).toHaveLength(0);
  });

  it("rejects a single label because a choice needs at least two", async () => {
    const result = await call("classify", { items: ["x"], labels: ["only"] });
    expect(result).toEqual({ isError: true, content: "labels must list at least 2 labels" });
  });

  it("tells the agent how to set the key when it is missing", async () => {
    const result = await call("classify", { items: ["x"], labels: ["a", "b"] }, "");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("jazz plugin secret set com.jazz.plugins.jev apiKey");
  });

  it("returns a tool error when Jev refuses", async () => {
    respondWith({ item_1: { type: "refusal" } });
    const result = await call("classify", { items: ["x"], labels: ["a", "b"] });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("Jev ");
  });
});

describe("rank", () => {
  it("scores every item on the scale and returns them best first", async () => {
    const requests = respondWith({
      item_1: {
        type: "score",
        score: 1,
        legend: { "0": "bad", "1": "ok", "2": "great" },
        probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
        confidence: 0.5,
      },
      item_2: {
        type: "score",
        score: 1.8,
        legend: { "0": "bad", "1": "ok", "2": "great" },
        probabilities: { "0": 0, "1": 0.2, "2": 0.8 },
        confidence: 0.8,
      },
    });
    const result = await call("rank", {
      items: ["Studio, 40m², far from metro", "3 rooms, 70m², next to metro"],
      criterion: "fits a family of 3 near a metro",
      levels: ["bad", "ok", "great"],
    });

    expect(requests[0]?.body).toMatchObject({
      questions: {
        item_1: { type: "score", criteria: ["bad", "ok", "great"] },
        item_2: { type: "score", criteria: ["bad", "ok", "great"] },
      },
    });
    expect(JSON.parse(result.content)).toMatchObject({
      levels: ["bad", "ok", "great"],
      ranking: [
        { item: 2, score: 0.9, level: "great", confidence: 0.8 },
        { item: 1, score: 0.5, level: "ok", confidence: 0.5 },
      ],
    });
  });

  it("uses the default five-level scale when none is given", async () => {
    const requests = respondWith({
      item_1: {
        type: "score",
        score: 4,
        legend: {},
        probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 },
        confidence: 1,
      },
    });
    await call("rank", { items: ["x"], criterion: "anything" });
    expect(requests[0]?.body).toMatchObject({
      questions: {
        item_1: {
          criteria: ["poor fit", "weak fit", "partial fit", "good fit", "excellent fit"],
        },
      },
    });
  });

  it("requires a criterion", async () => {
    const result = await call("rank", { items: ["x"] });
    expect(result).toEqual({
      isError: true,
      content: "criterion must describe what makes an item better",
    });
  });
});
