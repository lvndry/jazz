/** Exercises the Jev memory-pass gate at the plugin boundary: what it sends and what it returns. */

import type {
  AdvisoryHookHandler,
  AdvisoryHookId,
  MemoryPassGateInput,
  MemoryPassGateOutcome,
  PluginHostApi,
} from "@jazz/plugin-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import plugin, { JEV_BASE_URL, JEV_MODEL } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function memoryGate(): AdvisoryHookHandler<"gate.memory-pass"> {
  const handlers = new Map<AdvisoryHookId, unknown>();
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: { register: (hookId, handler) => handlers.set(hookId, handler) },
    policy: { register: () => {} },
    decisions: {
      registerProvider: (provider) => ({
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
      }),
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
    lifecycle: { register: () => {} },
    workspace: { register: () => {} },
    secrets: { get: async () => "test-key" },
  };
  plugin.register(api);
  const handler = handlers.get("gate.memory-pass");
  if (handler === undefined) {
    throw new Error("gate.memory-pass is not registered");
  }
  return handler as AdvisoryHookHandler<"gate.memory-pass">;
}

function respondWith(answers: unknown, status = 200): unknown[] {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe(`${JEV_BASE_URL}/systemone`);
    bodies.push(JSON.parse(String(init?.body)));
    if (status !== 200) {
      return new Response("unavailable", { status });
    }
    return Response.json({
      model: JEV_MODEL,
      answers,
      usage: { input_tokens: 300, output_tokens: 2 },
    });
  }) as typeof fetch;
  return bodies;
}

const input: MemoryPassGateInput = {
  pass: "conversation-end",
  messages: [
    { role: "user", text: "Remind me to call the dentist tomorrow." },
    { role: "assistant", text: "Reminder set for 9am tomorrow." },
  ],
};
const signal = new AbortController().signal;

describe("Jev memory-pass gate", () => {
  it("asks about durable facts and assistant mistakes in one request and returns the higher probability", async () => {
    const bodies = respondWith({
      durable_fact: { type: "noul", noul: 0.04 },
      assistant_mistake: { type: "noul", noul: 0.12 },
    });
    const outcome: MemoryPassGateOutcome = await memoryGate()(input, { signal });

    expect(outcome).toEqual({ status: "answered", worthScanningProbability: 0.12 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      state: { moment: "conversation ended", messages: input.messages },
      questions: { durable_fact: { type: "noul" }, assistant_mistake: { type: "noul" } },
    });
  });

  it("abstains when TypeSafe fails, so the pass runs", async () => {
    respondWith({}, 503);
    const outcome = await memoryGate()(input, { signal });
    expect(outcome).toEqual({ status: "abstained", reason: "provider failed" });
  });

  it("abstains without a request when the transcript is too large to send", async () => {
    const bodies = respondWith({});
    const outcome = await memoryGate()(
      { pass: "compaction", messages: [{ role: "user", text: "é".repeat(40_000) }] },
      { signal },
    );
    expect(outcome).toEqual({ status: "abstained", reason: "memory pass input exceeds limits" });
    expect(bodies).toHaveLength(0);
  });
});
