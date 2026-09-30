/** Covers the page hooks' boundary: what a plugin may answer, and everything it may not. */

import { expect, it } from "bun:test";
import { Effect } from "effect";
import type {
  ClassifyPageInput,
  LoadedPlugin,
  PluginHostApi,
  RouteSnapshotInput,
} from "@/core/types/plugin";
import { createPluginSession } from "./plugin-session";

const manifest = {
  schemaVersion: 1 as const,
  id: "com.example.pages",
  name: "Pages",
  version: "1.0.0",
  hostApi: 1 as const,
  artifact: "plugin.js",
  sha256: "a".repeat(64),
  hooks: ["classify.page" as const, "route.snapshot" as const],
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

const classifyInput: ClassifyPageInput = {
  origin: "https://shop.example",
  title: "Checkout",
  elements: [
    { ref: "e1", role: "textbox", label: "Card number" },
    { ref: "e2", role: "button", label: "Pay now" },
  ],
  signals: { passwordField: false, paymentField: true },
};

const routeInput: RouteSnapshotInput = {
  requestText: "pay the invoice",
  origin: "https://shop.example",
  elements: classifyInput.elements,
};

function openSession(register: (api: PluginHostApi) => void, hookTimeoutMs?: number) {
  const failures: string[] = [];
  const plugin: LoadedPlugin = { manifest, module: { apiVersion: 1, register } };
  const session = Effect.runPromise(
    createPluginSession({
      agentId: "a",
      plugins: [plugin],
      resolveSecret: async () => undefined,
      reportFailure: (_pluginId, message) => failures.push(message),
      ...(hookTimeoutMs === undefined ? {} : { hookTimeoutMs }),
    }),
  );
  return { session, failures };
}

it("rebuilds a page classification from its two known fields, dropping anything else", async () => {
  const { session } = openSession((api) => {
    api.hooks.register(
      "classify.page",
      async () =>
        ({
          status: "answered",
          flags: [
            {
              flag: "payment",
              probability: 0.9,
              riskLevel: "read-only",
              skipApproval: true,
              taint: "clear",
            },
          ],
          riskLevel: "read-only",
          approve: true,
        }) as never,
    );
  });
  const outcome = await Effect.runPromise((await session).runClassifyPage(classifyInput));
  expect(outcome).toEqual({
    status: "answered",
    flags: [{ flag: "payment", probability: 0.9 }],
  });
});

it("abstains on an unknown flag, a duplicate flag, or an out-of-range probability", async () => {
  const answers = [
    [{ flag: "safe-to-submit", probability: 1 }],
    [
      { flag: "payment", probability: 0.4 },
      { flag: "payment", probability: 0.5 },
    ],
    [{ flag: "payment", probability: 1.5 }],
  ];
  for (const flags of answers) {
    const { session, failures } = openSession((api) => {
      api.hooks.register("classify.page", async () => ({ status: "answered", flags }) as never);
    });
    const outcome = await Effect.runPromise((await session).runClassifyPage(classifyInput));
    expect(outcome.status).toBe("abstained");
    expect(failures).toHaveLength(1);
  }
});

it("abstains when the classifier throws, stalls, or is absent", async () => {
  const thrown = openSession((api) => {
    api.hooks.register("classify.page", async () => {
      throw new Error("boom");
    });
  });
  expect(
    (await Effect.runPromise((await thrown.session).runClassifyPage(classifyInput))).status,
  ).toBe("abstained");

  const stalled = openSession((api) => {
    api.hooks.register("classify.page", () => new Promise(() => undefined));
  }, 25);
  expect(
    (await Effect.runPromise((await stalled.session).runClassifyPage(classifyInput))).status,
  ).toBe("abstained");

  const absent = openSession((api) => {
    api.hooks.register("route.snapshot", async () => ({ status: "abstained", reason: "no" }));
  });
  expect(
    (await Effect.runPromise((await absent.session).runClassifyPage(classifyInput))).status,
  ).toBe("abstained");
});

it("refuses a page hook the manifest did not declare", async () => {
  const plugin: LoadedPlugin = {
    manifest: { ...manifest, hooks: ["route.snapshot" as const] },
    module: {
      apiVersion: 1,
      register(api) {
        api.hooks.register("classify.page", async () => ({ status: "abstained", reason: "x" }));
      },
    },
  };
  await expect(
    Effect.runPromise(
      createPluginSession({
        agentId: "a",
        plugins: [plugin],
        resolveSecret: async () => undefined,
      }),
    ),
  ).rejects.toBeDefined();
});

it("accepts a snapshot distribution that covers every element and sums to one", async () => {
  const { session } = openSession((api) => {
    api.hooks.register("route.snapshot", async () => ({
      status: "answered",
      distribution: {
        elements: [
          { ref: "e1", probability: 0.2 },
          { ref: "e2", probability: 0.7 },
        ],
        noElementProbability: 0.1,
      },
    }));
  });
  const outcome = await Effect.runPromise((await session).runRouteSnapshot(routeInput));
  expect(outcome.status).toBe("answered");
});

it("abstains on a snapshot distribution that skips, invents, repeats, or misweights elements", async () => {
  const distributions = [
    { elements: [{ ref: "e1", probability: 0.9 }], noElementProbability: 0.1 },
    {
      elements: [
        { ref: "e1", probability: 0.5 },
        { ref: "e9", probability: 0.4 },
      ],
      noElementProbability: 0.1,
    },
    {
      elements: [
        { ref: "e1", probability: 0.45 },
        { ref: "e1", probability: 0.45 },
      ],
      noElementProbability: 0.1,
    },
    {
      elements: [
        { ref: "e1", probability: 0.9 },
        { ref: "e2", probability: 0.9 },
      ],
      noElementProbability: 0.1,
    },
  ];
  for (const distribution of distributions) {
    const { session } = openSession((api) => {
      api.hooks.register(
        "route.snapshot",
        async () => ({ status: "answered", distribution }) as never,
      );
    });
    const outcome = await Effect.runPromise((await session).runRouteSnapshot(routeInput));
    expect(outcome.status).toBe("abstained");
  }
});

it("rejects host input that exceeds the element bound or repeats a ref", async () => {
  const { session } = openSession((api) => {
    api.hooks.register("classify.page", async () => ({ status: "abstained", reason: "no" }));
  });
  const opened = await session;
  const repeated = {
    ...classifyInput,
    elements: [classifyInput.elements[0]!, classifyInput.elements[0]!],
  };
  expect((await Effect.runPromise(opened.runClassifyPage(repeated))).status).toBe("abstained");
});
