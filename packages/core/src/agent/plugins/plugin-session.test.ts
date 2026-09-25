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
  policyHooks: [],
  decisionProviders: ["p"],
  tools: [],
  commands: [],
  personas: [],
  skills: [],
  lifecycleHooks: [],
  network: { destinations: [] },
  dataSent: [],
  secrets: [{ name: "key", required: true, description: "API key" }],
  claimsNotifications: false,
};

it("runs declared workspace context with bounded output and disables a failing handler", async () => {
  const failures: string[] = [];
  const inputs: string[] = [];
  let calls = 0;
  const plugin: LoadedPlugin = {
    manifest: { ...manifest, hooks: [], decisionProviders: [], workspace: true },
    module: {
      apiVersion: 1,
      register(api) {
        api.workspace.register(async (input) => {
          calls++;
          inputs.push(JSON.stringify(input));
          if (calls === 2) throw new Error("server failed");
          return { content: "diagnostic: " + "x".repeat(10_000) };
        });
      },
    },
  };
  const session = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [plugin],
      resolveSecret: async () => undefined,
      reportFailure: (_pluginId, message) => failures.push(message),
    }),
  );
  const input = {
    cwd: "/tmp/project",
    files: [{ path: "/tmp/project/a.ts", kind: "read" as const }],
  };
  const first = await Effect.runPromise(session.runWorkspace(input));
  expect(first).toContain("diagnostic:");
  expect(first!.length).toBeLessThan(4_100);
  expect(inputs).toEqual([JSON.stringify(input)]);
  expect(await Effect.runPromise(session.runWorkspace(input))).toBeUndefined();
  expect(await Effect.runPromise(session.runWorkspace(input))).toBeUndefined();
  expect(calls).toBe(2);
  expect(failures).toEqual(["server failed"]);
  await Effect.runPromise(session.close());
});

it("rejects workspace registration when the manifest has not declared it", async () => {
  await expect(
    Effect.runPromise(
      createPluginSession({
        agentId: "a",
        plugins: [
          {
            manifest,
            module: {
              apiVersion: 1,
              register: (api) => api.workspace.register(async () => undefined),
            },
          },
        ],
        resolveSecret: async () => undefined,
      }),
    ),
  ).rejects.toThrow("failed to open plugin session");
});

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

it("registers policy hooks separately and validates their full distribution", async () => {
  let calls = 0;
  const session = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest: { ...manifest, hooks: [], policyHooks: ["classify.command-risk"] },
          module: {
            apiVersion: 1,
            register(api) {
              api.policy.register("classify.command-risk", async ({ command }) => {
                calls += 1;
                return command === "git status"
                  ? {
                      status: "answered",
                      distribution: {
                        readOnlyProbability: 0.9,
                        lowRiskProbability: 0.05,
                        highRiskProbability: 0.05,
                      },
                    }
                  : {
                      status: "answered",
                      distribution: {
                        readOnlyProbability: 0.9,
                        lowRiskProbability: 0.05,
                        highRiskProbability: 0.15,
                      },
                    };
              });
            },
          },
        },
      ],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => undefined,
    }),
  );
  expect(
    await Effect.runPromise(
      session.runPolicyHook("classify.command-risk", { command: "git status" }),
    ),
  ).toEqual({
    status: "answered",
    distribution: {
      readOnlyProbability: 0.9,
      lowRiskProbability: 0.05,
      highRiskProbability: 0.05,
    },
  });
  expect(
    await Effect.runPromise(session.runPolicyHook("classify.command-risk", { command: "rm x" })),
  ).toEqual({ status: "abstained", reason: "plugin policy handler failed" });
  expect(
    await Effect.runPromise(
      session.runPolicyHook("classify.command-risk", { command: "x".repeat(4_001) }),
    ),
  ).toEqual({ status: "abstained", reason: "plugin policy handler failed" });
  expect(calls).toBe(2);
});

it("abstains when no policy handler is registered", async () => {
  const noHandler = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => undefined,
    }),
  );
  expect(
    await Effect.runPromise(
      noHandler.runPolicyHook("classify.command-risk", { command: "git status" }),
    ),
  ).toEqual({ status: "abstained", reason: "no plugin policy handler" });
});

it("bounds policy hook execution by the session deadline", async () => {
  const session = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest: { ...manifest, hooks: [], policyHooks: ["classify.command-risk"] },
          module: {
            apiVersion: 1,
            register(api) {
              api.policy.register(
                "classify.command-risk",
                () =>
                  new Promise((resolve) =>
                    setTimeout(
                      () =>
                        resolve({
                          status: "answered",
                          distribution: {
                            readOnlyProbability: 0,
                            lowRiskProbability: 0,
                            highRiskProbability: 1,
                          },
                        }),
                      50,
                    ),
                  ),
              );
            },
          },
        },
      ],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      hookTimeoutMs: 1,
      resolveSecret: async () => undefined,
    }),
  );
  expect(
    await Effect.runPromise(
      session.runPolicyHook("classify.command-risk", { command: "git status" }),
    ),
  ).toEqual({ status: "abstained", reason: "plugin policy handler failed" });
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

const toolManifest = {
  ...manifest,
  tools: [
    {
      name: "reverse_text",
      description: "Reverse text.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      riskLevel: "read-only" as const,
      egress: false,
    },
  ],
};

const makeToolSession = (
  module: LoadedPlugin["module"],
  riskLevel: "read-only" | "high-risk" = "read-only",
) =>
  createPluginSession({
    agentId: "a",
    plugins: [
      {
        manifest: {
          ...toolManifest,
          tools: toolManifest.tools.map((tool) => ({ ...tool, riskLevel })),
        },
        module,
      },
    ],
    metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
    resolveSecret: async () => "secret",
  });

it("lists a declared tool and runs its handler", async () => {
  const session = await Effect.runPromise(
    makeToolSession({
      apiVersion: 1,
      register(api) {
        api.tools.register({
          name: "reverse_text",
          handler: async (args) => ({ content: String(args["text"]).split("").reverse().join("") }),
        });
      },
    }),
  );
  expect(session.listTools().map((tool) => tool.name)).toEqual(["reverse_text"]);
  expect(session.listTools()[0]?.pluginId).toBe("com.example.router");
  const result = await Effect.runPromise(
    session.runTool("reverse_text", { text: "abc" }, process.cwd()),
  );
  expect(result).toEqual({ content: "cba" });
});

it("rejects a tool the manifest did not declare", async () => {
  const outcome = await Effect.runPromise(
    makeToolSession({
      apiVersion: 1,
      register(api) {
        api.tools.register({ name: "undeclared", handler: async () => ({ content: "x" }) });
      },
    }).pipe(Effect.either),
  );
  expect(outcome._tag).toBe("Left");
});

it("returns an error result when the handler throws, so the host falls back", async () => {
  const session = await Effect.runPromise(
    makeToolSession({
      apiVersion: 1,
      register(api) {
        api.tools.register({
          name: "reverse_text",
          handler: async () => {
            throw new Error("kaboom");
          },
        });
      },
    }),
  );
  const result = await Effect.runPromise(
    session.runTool("reverse_text", { text: "abc" }, process.cwd()),
  );
  expect(result.isError).toBe(true);
});

it("returns an error result for an unknown tool name", async () => {
  const session = await Effect.runPromise(
    makeToolSession({
      apiVersion: 1,
      register(api) {
        api.tools.register({
          name: "reverse_text",
          handler: async () => ({ content: "ok" }),
        });
      },
    }),
  );
  const result = await Effect.runPromise(session.runTool("does_not_exist", {}, process.cwd()));
  expect(result.isError).toBe(true);
});

it("rejects a non-serializable prepared approval before showing it", async () => {
  const session = await Effect.runPromise(
    makeToolSession(
      {
        apiVersion: 1,
        register(api) {
          api.tools.register({
            name: "reverse_text",
            handler: async () => ({ content: "unused" }),
            prepare: async () => ({ message: "Review", prepared: { value: BigInt(1) } as never }),
            executePrepared: async () => ({ content: "unused" }),
          });
        },
      },
      "high-risk",
    ),
  );
  const result = await Effect.runPromise(session.prepareTool("reverse_text", {}, process.cwd()));
  expect("isError" in result && result.isError).toBe(true);
});

const lifecycleManifest = {
  ...manifest,
  lifecycleHooks: ["run-complete" as const],
};

it("delivers a declared lifecycle event to its handler", async () => {
  let received: unknown;
  const session = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest: lifecycleManifest,
          module: {
            apiVersion: 1,
            register(api) {
              api.lifecycle.register({
                event: "run-complete",
                handler: async (event) => {
                  received = event.data?.["summary"];
                },
              });
            },
          },
        },
      ],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => "secret",
    }),
  );
  await Effect.runPromise(
    session.emitLifecycle({
      event: "run-complete",
      agentId: "a",
      conversationId: "c",
      cwd: "/tmp",
      data: { summary: "all done" },
    }),
  );
  expect(received).toBe("all done");
});

it("gives lifecycle handlers a writeTerminalSequence routed to the host", async () => {
  const written: string[] = [];
  let handlerWrote = false;
  const session = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest: lifecycleManifest,
          module: {
            apiVersion: 1,
            register(api) {
              api.lifecycle.register({
                event: "run-complete",
                handler: async (_event, context) => {
                  handlerWrote = typeof context.writeTerminalSequence === "function";
                  context.writeTerminalSequence("\u001b]777;notify;t;b\u0007");
                },
              });
            },
          },
        },
      ],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => "secret",
      writeTerminalSequence: (data) => written.push(data),
    }),
  );
  await Effect.runPromise(
    session.emitLifecycle({
      event: "run-complete",
      agentId: "a",
      conversationId: "c",
      cwd: "/tmp",
    }),
  );
  expect(handlerWrote).toBe(true);
  expect(written).toEqual(["\u001b]777;notify;t;b\u0007"]);
});

it("rejects a lifecycle subscription the manifest did not declare", async () => {
  const outcome = await Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [
        {
          manifest,
          module: {
            apiVersion: 1,
            register(api) {
              api.lifecycle.register({ event: "run-complete", handler: async () => {} });
            },
          },
        },
      ],
      metrics: createAgentRunMetrics({ agent, conversationId: "c" }),
      resolveSecret: async () => "secret",
    }).pipe(Effect.either),
  );
  expect(outcome._tag).toBe("Left");
});
