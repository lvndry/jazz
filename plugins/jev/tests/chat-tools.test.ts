/** Exercises the classify and rank tools at the plugin boundary: what they send and what they return. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginToolRegistration, PluginToolResult } from "@jazz/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAX_ITEM_FILE_CHARS, NONE_LABEL } from "../src/chat-tools";
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
  readonly body: {
    readonly state: unknown;
    readonly questions: Record<
      string,
      { type: string; instructions: { item: unknown }; criteria?: unknown }
    >;
    readonly assets?: Record<string, { type: string; part: string }>;
  } & Record<string, unknown>;
  readonly imageParts: number;
}

/** Answers every request with `answerFor(question)` for each question it carries. */
function respondPerQuestion(
  answerFor: (question: { instructions: { item: unknown } }) => unknown,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    let body: RecordedRequest["body"];
    let imageParts = 0;
    if (init?.body instanceof FormData) {
      const request = init.body.get("request") as Blob;
      imageParts = [...init.body.keys()].filter((key) => key.startsWith("image-")).length;
      body = JSON.parse(await request.text()) as RecordedRequest["body"];
    } else {
      body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
    }
    requests.push({ url: String(input), body, imageParts });
    return Response.json({
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([key, question]) => [key, answerFor(question)]),
      ),
      usage: { input_tokens: 400, output_tokens: 6 },
    });
  }) as typeof fetch;
  return requests;
}

function itemText(question: { instructions: { item: unknown } }): string {
  return (question.instructions.item as { text?: string }).text ?? "";
}

function choice(label: string, probabilities: Record<string, number>, confidence = 0.9): unknown {
  return { type: "choice", choice: label, probabilities, confidence };
}

describe("classify", () => {
  it("sends each item inside its own question with a state holding only the task and context", async () => {
    const requests = respondPerQuestion((question) =>
      itemText(question).startsWith("Server")
        ? choice("urgent", { urgent: 0.9, newsletter: 0.05, [NONE_LABEL]: 0.05 }, 0.88)
        : choice("newsletter", { urgent: 0.05, newsletter: 0.9, [NONE_LABEL]: 0.05 }, 0.94),
    );
    const result = await call("classify", {
      items: ["Server down, customers affected", { id: "digest", text: "Weekly digest #42" }],
      labels: [{ name: "urgent", description: "Needs action today" }, "newsletter"],
      instructions: "By what the user needs to do with it.",
      context: "The user runs a small SaaS.",
    });

    expect(result.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${JEV_BASE_URL}/systemone`);
    expect(requests[0]?.body.state).toEqual({
      task: "Classify the item in each question. By what the user needs to do with it.",
      context: "The user runs a small SaaS.",
    });
    expect(Object.values(requests[0]?.body.questions ?? {})).toEqual([
      {
        type: "choice",
        instructions: { item: { text: "Server down, customers affected" } },
        criteria: {
          urgent: "Needs action today",
          newsletter: null,
          [NONE_LABEL]: expect.any(String),
        },
      },
      {
        type: "choice",
        instructions: { item: { text: "Weekly digest #42" } },
        criteria: {
          urgent: "Needs action today",
          newsletter: null,
          [NONE_LABEL]: expect.any(String),
        },
      },
    ]);
    expect(JSON.parse(result.content)).toEqual({
      model: JEV_MODEL,
      results: [
        {
          id: 1,
          label: "urgent",
          probabilities: { urgent: 0.9, newsletter: 0.05, [NONE_LABEL]: 0.05 },
          confidence: 0.88,
        },
        {
          id: "digest",
          label: "newsletter",
          probabilities: { urgent: 0.05, newsletter: 0.9, [NONE_LABEL]: 0.05 },
          confidence: 0.94,
        },
      ],
      usage: { inputTokens: 400, costUSD: (400 * 0.042) / 1_000_000, requests: 1 },
    });
  });

  it("flags a label Jev rates more likely wrong than right as uncertain", async () => {
    respondPerQuestion(() => choice("a", { a: 0.45, b: 0.4, [NONE_LABEL]: 0.15 }));
    const result = await call("classify", { items: ["x"], labels: ["a", "b"] });
    expect(JSON.parse(result.content).results[0]).toMatchObject({ label: "a", uncertain: true });
  });

  it("returns only the kept labels and counts the rest", async () => {
    respondPerQuestion((question) =>
      itemText(question) === "fire"
        ? choice("urgent", { urgent: 1, later: 0, [NONE_LABEL]: 0 })
        : choice("later", { urgent: 0, later: 1, [NONE_LABEL]: 0 }),
    );
    const result = await call("classify", {
      items: ["fire", "lunch", "invoice"],
      labels: ["urgent", "later"],
      keep: ["urgent"],
    });
    const content = JSON.parse(result.content);
    expect(content.results.map((entry: { id: number }) => entry.id)).toEqual([1]);
    expect(content.omitted).toEqual({ later: 2 });
  });

  it("rejects a keep label that is not offered", async () => {
    const result = await call("classify", { items: ["x"], labels: ["a", "b"], keep: ["c"] });
    expect(result).toEqual({
      isError: true,
      content: 'keep names "c", which is not one of the labels',
    });
  });

  it("reads matched files as items named by their paths, cutting long ones short", async () => {
    await mkdir(join(workingDirectory, "inbox"));
    await writeFile(join(workingDirectory, "inbox", "a.eml"), "Server down");
    await writeFile(join(workingDirectory, "inbox", "b.eml"), "x".repeat(MAX_ITEM_FILE_CHARS + 50));
    const requests = respondPerQuestion(() => choice("a", { a: 1, b: 0, [NONE_LABEL]: 0 }));
    const result = await call("classify", { files: ["inbox/*.eml"], labels: ["a", "b"] });

    const items = Object.values(requests[0]?.body.questions ?? {}).map(itemText);
    expect(items[0]).toBe("Server down");
    expect(items[1]).toHaveLength(MAX_ITEM_FILE_CHARS);
    expect(JSON.parse(result.content).results).toEqual([
      expect.objectContaining({ id: "inbox/a.eml" }),
      expect.objectContaining({ id: "inbox/b.eml", truncated: true }),
    ]);
  });

  it("rejects a files pattern that matches nothing, and a binary file", async () => {
    expect(await call("classify", { files: ["missing/*.txt"], labels: ["a", "b"] })).toEqual({
      isError: true,
      content: "files pattern missing/*.txt matches no file",
    });
    await writeFile(join(workingDirectory, "blob.bin"), new Uint8Array([0x41, 0, 0x42]));
    expect(await call("classify", { items: [{ file: "blob.bin" }], labels: ["a", "b"] })).toEqual({
      isError: true,
      content: "file blob.bin is not a text file",
    });
  });

  it("splits items across parallel requests that fit Jev's input limit, and keeps their order", async () => {
    const requests = respondPerQuestion(() => choice("a", { a: 1, b: 0, [NONE_LABEL]: 0 }));
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `doc-${index}`,
      text: `${index} ${"word ".repeat(1_500)}`,
    }));
    const result = await call("classify", { items, labels: ["a", "b"] });

    expect(requests.length).toBeGreaterThan(1);
    const content = JSON.parse(result.content);
    expect(content.results.map((entry: { id: string }) => entry.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(content.usage.requests).toBe(requests.length);
  });

  it("sends an image only with the question that names it", async () => {
    await writeFile(join(workingDirectory, "receipt.png"), PNG_BYTES);
    const requests = respondPerQuestion(() =>
      choice("business", { business: 0.7, personal: 0.3, [NONE_LABEL]: 0 }),
    );
    const result = await call("classify", {
      items: [{ image: "receipt.png", text: "Dinner, 3 people" }, "Taxi"],
      labels: ["business", "personal"],
    });

    expect(result.isError).toBeUndefined();
    expect(requests[0]?.imageParts).toBe(1);
    const [reference] = Object.keys(requests[0]?.body.assets ?? {});
    expect(reference).toMatch(/^\[image-/);
    expect(JSON.stringify(requests[0]?.body.state)).not.toContain(reference ?? "");
    const [withImage, withoutImage] = Object.values(requests[0]?.body.questions ?? {});
    expect(withImage?.instructions.item).toEqual({ text: "Dinner, 3 people", image: reference });
    expect(JSON.stringify(withoutImage)).not.toContain(reference ?? "");
  });

  it("rejects a file that is not a PNG or JPEG before calling Jev", async () => {
    await writeFile(join(workingDirectory, "notes.txt"), "plain text");
    const requests = respondPerQuestion(() => ({}));
    const result = await call("classify", { items: [{ image: "notes.txt" }], labels: ["a", "b"] });
    expect(result).toEqual({ isError: true, content: "image notes.txt is not a PNG or JPEG file" });
    expect(requests).toHaveLength(0);
  });

  it("rejects repeated item ids, a single label, and a call with no items", async () => {
    expect(
      await call("classify", {
        items: [
          { id: "a", text: "x" },
          { id: "a", text: "y" },
        ],
        labels: ["p", "q"],
      }),
    ).toEqual({ isError: true, content: "item id a appears twice" });
    expect(await call("classify", { items: ["x"], labels: ["only"] })).toEqual({
      isError: true,
      content: "labels must list at least 2 labels",
    });
    expect(await call("classify", { labels: ["a", "b"] })).toEqual({
      isError: true,
      content: "give items, files, or both",
    });
  });

  it("tells the agent how to set the key when it is missing", async () => {
    const result = await call("classify", { items: ["x"], labels: ["a", "b"] }, "");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("jazz plugin secret set com.jazz.plugins.jev apiKey");
  });

  it("returns a tool error when Jev refuses", async () => {
    respondPerQuestion(() => ({ type: "refusal" }));
    const result = await call("classify", { items: ["x"], labels: ["a", "b"] });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("Jev ");
  });
});

function score(value: number, confidence: number): unknown {
  return {
    type: "score",
    score: value,
    legend: { "0": "bad", "1": "ok", "2": "great" },
    probabilities: { "0": 0, "1": 2 - value, "2": value - 1 },
    confidence,
  };
}

describe("rank", () => {
  it("scores every item on the scale and returns them best first", async () => {
    const requests = respondPerQuestion((question) =>
      itemText(question).startsWith("Studio") ? score(1, 0.5) : score(1.8, 0.8),
    );
    const result = await call("rank", {
      items: ["Studio, 40m², far from metro", "3 rooms, 70m², next to metro"],
      criterion: "fits a family of 3 near a metro",
      levels: ["bad", "ok", "great"],
    });

    expect(requests[0]?.body.state).toEqual({
      task: "Rate the item in each question against this criterion: fits a family of 3 near a metro",
    });
    expect(Object.values(requests[0]?.body.questions ?? {})[0]).toEqual({
      type: "score",
      instructions: { item: { text: "Studio, 40m², far from metro" } },
      criteria: ["bad", "ok", "great"],
    });
    expect(JSON.parse(result.content)).toMatchObject({
      levels: ["bad", "ok", "great"],
      ranking: [
        { id: 2, score: 0.9, level: "great", confidence: 0.8 },
        { id: 1, score: 0.5, level: "ok", confidence: 0.5 },
      ],
    });
  });

  it("puts the more confident item first among equal scores, and returns only the top ones", async () => {
    respondPerQuestion((question) =>
      itemText(question) === "sure" ? score(1.5, 0.9) : score(1.5, 0.4),
    );
    const result = await call("rank", {
      items: ["unsure", "sure", "also unsure"],
      criterion: "anything",
      levels: ["bad", "ok", "great"],
      top: 1,
    });
    const content = JSON.parse(result.content);
    expect(content.ranking.map((entry: { id: number }) => entry.id)).toEqual([2]);
    expect(content.omitted).toBe(2);
  });

  it("uses the default five-level scale when none is given", async () => {
    const requests = respondPerQuestion(() => ({
      type: "score",
      score: 4,
      legend: {},
      probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 },
      confidence: 1,
    }));
    await call("rank", { items: ["x"], criterion: "anything" });
    expect(Object.values(requests[0]?.body.questions ?? {})[0]).toMatchObject({
      criteria: ["poor fit", "weak fit", "partial fit", "good fit", "excellent fit"],
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
