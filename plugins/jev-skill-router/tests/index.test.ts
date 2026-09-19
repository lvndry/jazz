/** Exercises the Jev adapter at its public plugin boundary with a fake host. */

import type {
  AdvisoryHookHandler,
  AdvisoryHookId,
  DecisionProvider,
  JazzPluginModule,
  PluginHostApi,
} from "@jazz/plugin-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import plugin, { JEV_API_URL, JEV_MODEL } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeHost(): {
  readonly api: PluginHostApi;
  readonly providers: DecisionProvider[];
  readonly handlers: Map<AdvisoryHookId, AdvisoryHookHandler<AdvisoryHookId>>;
} {
  const providers: DecisionProvider[] = [];
  const handlers = new Map<AdvisoryHookId, AdvisoryHookHandler<AdvisoryHookId>>();
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: {
      register(hookId, handler) {
        handlers.set(hookId, handler as unknown as AdvisoryHookHandler<AdvisoryHookId>);
      },
    },
    decisions: {
      registerProvider: (provider) => {
        providers.push(provider);
        return {
          decide: async (request, context) => {
            try {
              return await provider.decide(request, {
                signal: context?.signal ?? new AbortController().signal,
              });
            } catch {
              return {
                providerId: provider.id,
                model: "unavailable",
                latencyMs: 0,
                answers: request.questions.map(({ id }) => ({
                  id,
                  outcome: { status: "abstained" as const, reason: "provider failed" },
                })),
              };
            }
          },
        };
      },
    },
    secrets: { get: async () => "test-key" },
  };
  return { api, providers, handlers };
}

function register(module: JazzPluginModule = plugin) {
  const host = fakeHost();
  module.register(host.api);
  return host;
}

describe("Jev skill router", () => {
  it("registers one decision provider and route.skills handler", () => {
    const host = register();
    expect(host.providers).toHaveLength(1);
    expect(host.handlers.has("route.skills")).toBe(true);
  });

  it("maps Noul, Choice, and Score through the current System One schema", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: JEV_MODEL,
        answers: {
          relevant: { type: "noul", noul: 0.7 },
          category: {
            type: "choice",
            choice: "a",
            probabilities: { a: 0.8, b: 0.2 },
            confidence: 0.75,
          },
          urgency: {
            type: "score",
            score: 1.6,
            legend: { "0": "low", "1": "medium", "2": "high" },
            probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 250, output_tokens: 20 },
      });
    }) as typeof fetch;
    const host = register();
    const result = await host.providers[0]?.decide(
      {
        state: { request: "classify" },
        questions: [
          { id: "relevant", question: { kind: "probability", instructions: "Relevant?" } },
          {
            id: "category",
            question: {
              kind: "choice",
              instructions: "Choose",
              options: [{ value: "a", criterion: "first" }, { value: "b" }],
            },
          },
          {
            id: "urgency",
            question: {
              kind: "score",
              instructions: "Rate urgency",
              levels: ["low", "medium", "high"],
            },
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(requestBody).toMatchObject({
      model: JEV_MODEL,
      questions: {
        relevant: { type: "noul" },
        category: { type: "choice", criteria: { a: "first", b: null } },
        urgency: { type: "score", criteria: ["low", "medium", "high"] },
      },
    });
    expect(result?.answers).toEqual([
      {
        id: "relevant",
        outcome: { status: "answered", answer: { kind: "probability", probability: 0.7 } },
      },
      {
        id: "category",
        outcome: {
          status: "answered",
          answer: {
            kind: "choice",
            choice: "a",
            probabilities: [
              { value: "a", probability: 0.8 },
              { value: "b", probability: 0.2 },
            ],
          },
        },
      },
      { id: "urgency", outcome: { status: "answered", answer: { kind: "score", score: 1.6 } } },
    ]);
  });

  it("uses the pinned model and returns a complete routing distribution", async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(JEV_API_URL);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        model: JEV_MODEL,
        answers: {
          best_skill: {
            type: "choice",
            choice: "skill_0",
            probabilities: { no_skill: 0.05, skill_0: 0.9, skill_1: 0.05 },
            confidence: 0.91,
          },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
      });
    }) as typeof fetch;
    const host = register();
    const handler = host.handlers.get("route.skills");
    const result = await handler?.(
      {
        requestText: "Review this pull request",
        skills: [
          { name: "pr-review", description: "Review a pull request" },
          { name: "pdf", description: "Read PDF files" },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({
      status: "answered",
      distribution: {
        noSkillProbability: 0.05,
        skills: [
          { name: "pr-review", probability: 0.9 },
          { name: "pdf", probability: 0.05 },
        ],
      },
    });
    expect(requestBody).toMatchObject({ model: JEV_MODEL });
  });

  it("fails open on a model-version mismatch", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        model: "jev-1.14.0",
        answers: {},
        usage: { input_tokens: 10, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const host = register();
    const result = await host.handlers.get("route.skills")?.(
      { requestText: "read this PDF", skills: [{ name: "pdf", description: "Read PDFs" }] },
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({ status: "abstained", reason: "provider failed" });
  });

  it("retries overloaded responses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("overloaded", { status: 529 });
      return Response.json({
        model: JEV_MODEL,
        answers: {
          best_skill: {
            type: "choice",
            choice: "no_skill",
            probabilities: { no_skill: 0.8, skill_0: 0.2 },
            confidence: 0.7,
          },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const host = register();
    const result = await host.handlers.get("route.skills")?.(
      { requestText: "hello", skills: [{ name: "pdf", description: "Read PDFs" }] },
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({
      status: "answered",
      distribution: {
        noSkillProbability: 0.8,
        skills: [{ name: "pdf", probability: 0.2 }],
      },
    });
    expect(calls).toBe(2);
  });
});
