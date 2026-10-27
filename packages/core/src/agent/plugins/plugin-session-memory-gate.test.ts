/** Covers the memory-pass gate's boundary: what a plugin receives, and what it may answer. */

import { expect, it } from "bun:test";
import { Effect } from "effect";
import {
  MAX_MEMORY_PASS_GATE_CHARS,
  type LoadedPlugin,
  type MemoryPassGateInput,
  type PluginHostApi,
} from "@/core/types/plugin";
import { createPluginSession } from "./plugin-session";

const manifest = {
  schemaVersion: 1 as const,
  id: "com.example.memory-gate",
  name: "Memory gate",
  version: "1.0.0",
  hostApi: 1 as const,
  artifact: "plugin.js",
  sha256: "a".repeat(64),
  hooks: ["gate.memory-pass" as const],
  policyHooks: [],
  decisionProviders: [],
  tools: [],
  commands: [],
  personas: [],
  skills: [],
  lifecycleHooks: [],
  network: { destinations: [] },
  dataSent: [],
  secrets: [],
  claimsNotifications: false,
};

const input: MemoryPassGateInput = {
  pass: "conversation-end",
  messages: [
    { role: "user", text: "I'm vegetarian, book somewhere that works." },
    { role: "assistant", text: "Booked Le Potager for 8pm." },
  ],
};

function openSession(register: (api: PluginHostApi) => void) {
  const failures: string[] = [];
  const plugin: LoadedPlugin = { manifest, module: { apiVersion: 1, register } };
  const session = Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [plugin],
      resolveSecret: async () => undefined,
      reportFailure: (_pluginId, message) => failures.push(message),
    }),
  );
  return { session, failures };
}

it("passes the transcript through and keeps only the probability from the answer", async () => {
  const received: MemoryPassGateInput[] = [];
  const { session } = openSession((api) => {
    api.hooks.register("gate.memory-pass", async (hookInput) => {
      received.push(hookInput);
      return {
        status: "answered",
        worthScanningProbability: 0.8,
        facts: ["user is vegetarian"],
        skip: false,
      } as never;
    });
  });
  const outcome = await Effect.runPromise((await session).runMemoryPassGate(input));
  expect(received).toEqual([input]);
  expect(outcome).toEqual({ status: "answered", worthScanningProbability: 0.8 });
});

it("abstains when the plugin answers out of range or throws", async () => {
  for (const handler of [
    async () => ({ status: "answered", worthScanningProbability: 1.5 }) as never,
    async () => {
      throw new Error("TypeSafe down");
    },
  ]) {
    const { session, failures } = openSession((api) => {
      api.hooks.register("gate.memory-pass", handler);
    });
    const outcome = await Effect.runPromise((await session).runMemoryPassGate(input));
    expect(outcome).toEqual({ status: "abstained", reason: "plugin handler failed" });
    expect(failures).toHaveLength(1);
  }
});

it("never calls the plugin with a transcript over the bound", async () => {
  let called = false;
  const { session } = openSession((api) => {
    api.hooks.register("gate.memory-pass", async () => {
      called = true;
      return { status: "answered", worthScanningProbability: 0 };
    });
  });
  const outcome = await Effect.runPromise(
    (await session).runMemoryPassGate({
      pass: "compaction",
      messages: [
        { role: "user", text: "a".repeat(MAX_MEMORY_PASS_GATE_CHARS) },
        { role: "assistant", text: "b" },
      ],
    }),
  );
  expect(called).toBe(false);
  expect(outcome.status).toBe("abstained");
});

it("abstains when no plugin handles the gate", async () => {
  const { session } = openSession(() => {});
  const outcome = await Effect.runPromise((await session).runMemoryPassGate(input));
  expect(outcome).toEqual({ status: "abstained", reason: "no plugin handler" });
});
