/** Covers per-run registration, secret scoping, provider budgets, and accounting. */

import { expect, it } from "bun:test";
import { Effect } from "effect";
import { createAgentRunMetrics } from "@/core/agent/metrics/agent-run-metrics";
import type { LoadedPlugin, PluginDecisionClient, PluginHostApi } from "@/core/types/plugin";
import { createPluginSession } from "./plugin-session";

const agent = {
  id: "a",
  name: "a",
  config: { persona: "p", llmProvider: "openai" as const, llmModel: "m" },
  model: "openai/m" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const manifest = {
  schemaVersion: 1 as const,
  id: "com.example.router",
  name: "Router",
  version: "1.0.0",
  hostApi: 1 as const,
  artifact: "plugin.js",
  sha256: "a".repeat(64),
  hooks: ["route.skills" as const],
  decisionProviders: ["p"],
  network: { destinations: [] },
  dataSent: [],
  secrets: [{ name: "key", required: true, description: "API key" }],
};

it("keeps registrations per run and enforces declared secrets", async () => {
  let apiSeen: PluginHostApi | undefined;
  const plugin: LoadedPlugin = {
    manifest,
    module: {
      apiVersion: 1,
      register(api) {
        apiSeen = api;
        api.hooks.register("route.skills", async (input) => ({
          status: "answered",
          distribution: {
            skills: input.skills.map(({ name }) => ({ name, probability: 0.75 })),
            noSkillProbability: 0.25,
          },
        }));
      },
    },
  };
  const make = () =>
    createPluginSession({
      agentId: "a",
      plugins: [plugin],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => "secret",
    });
  const first = await Effect.runPromise(make());
  const second = await Effect.runPromise(make());
  expect(
    (
      await Effect.runPromise(
        first.runHook("route.skills", {
          requestText: "x",
          skills: [{ name: "s", description: "d" }],
        }),
      )
    ).status,
  ).toBe("answered");
  expect(
    (
      await Effect.runPromise(
        second.runHook("route.skills", {
          requestText: "x",
          skills: [{ name: "s", description: "d" }],
        }),
      )
    ).status,
  ).toBe("answered");
  await expect(apiSeen!.secrets.get("undeclared")).rejects.toThrow("not declared");
});

it("routes provider calls through host accounting and budget", async () => {
  let client: PluginDecisionClient | undefined;
  const metrics = createAgentRunMetrics({ agent, conversationId: "c" });
  const plugin: LoadedPlugin = {
    manifest,
    module: {
      apiVersion: 1,
      register(api) {
        client = api.decisions.registerProvider({
          id: "p",
          maxCostUSDPerBatch: 0.1,
          networkBacked: true,
          async decide(request) {
            return {
              providerId: "p",
              model: "m",
              latencyMs: 2,
              costUSD: 0.05,
              usage: { inputTokens: 3, outputTokens: 1 },
              answers: request.questions.map(({ id }) => ({
                id,
                outcome: {
                  status: "answered" as const,
                  answer: { kind: "probability" as const, probability: 0.8 },
                },
              })),
            };
          },
        });
      },
    },
  };
  await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [plugin],
      metrics,
      maxCostUSD: 1,
      currentRunCostUSD: () => 0,
      resolveSecret: async () => undefined,
    }),
  );
  const result = await client!.decide({
    state: null,
    questions: [{ id: "q", question: { kind: "probability", instructions: "yes?" } }],
  });
  expect(result.providerId).toBe("p");
  expect(metrics.decisionRequests).toBe(1);
  expect(metrics.decisionCostUSD).toBe(0.05);
});

it("charges the reservation and disables a capped network provider that omits cost", async () => {
  let client: PluginDecisionClient | undefined;
  let calls = 0;
  const metrics = createAgentRunMetrics({ agent, conversationId: "c" });
  await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest,
          module: {
            apiVersion: 1,
            register(api) {
              client = api.decisions.registerProvider({
                id: "p",
                maxCostUSDPerBatch: 0.1,
                networkBacked: true,
                async decide(request) {
                  calls += 1;
                  return {
                    providerId: "p",
                    model: "m",
                    latencyMs: 1,
                    answers: request.questions.map(({ id }) => ({
                      id,
                      outcome: { status: "abstained" as const, reason: "unknown" },
                    })),
                  };
                },
              });
            },
          },
        },
      ],
      metrics,
      maxCostUSD: 1,
      currentRunCostUSD: () => metrics.decisionCostUSD ?? 0,
      resolveSecret: async () => undefined,
    }),
  );
  const request = {
    state: null,
    questions: [{ id: "q", question: { kind: "probability" as const, instructions: "yes?" } }],
  };
  expect((await client!.decide(request)).answers[0]?.outcome.status).toBe("abstained");
  expect(metrics.decisionCostUSD).toBe(0.1);
  await client!.decide(request);
  expect(calls).toBe(1);
});
