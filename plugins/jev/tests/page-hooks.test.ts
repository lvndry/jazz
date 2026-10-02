/** Exercises the Jev page hooks at the plugin boundary: what they send and what they return. */

import type {
  AdvisoryHookHandler,
  AdvisoryHookId,
  ClassifyPageInput,
  ClassifyPageOutcome,
  DecisionProvider,
  PluginHostApi,
  RouteSnapshotInput,
  RouteSnapshotOutcome,
} from "@jazz/plugin-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import plugin, { JEV_API_URL, JEV_MODEL } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PAGE_BODY_SENTINEL = "PAGE-BODY-TEXT-THAT-MUST-NOT-LEAVE";
const URL_PATH_SENTINEL = "/account/reset?token=SECRET-IN-URL";

function registerHandlers(): Map<AdvisoryHookId, AdvisoryHookHandler<AdvisoryHookId>> {
  const handlers = new Map<AdvisoryHookId, AdvisoryHookHandler<AdvisoryHookId>>();
  const providers: DecisionProvider[] = [];
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: {
      register(hookId, handler) {
        handlers.set(hookId, handler as unknown as AdvisoryHookHandler<AdvisoryHookId>);
      },
    },
    policy: { register: () => {} },
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
    tools: { register: () => {} },
    commands: { register: () => {} },
    lifecycle: { register: () => {} },
    workspace: { register: () => {} },
    secrets: { get: async () => "test-key" },
  };
  plugin.register(api);
  return handlers;
}

const signal = new AbortController().signal;

const classifyInput: ClassifyPageInput = {
  origin: "https://bank.example",
  title: "Sign in",
  elements: [
    { ref: "e1", role: "textbox", label: "Password" },
    { ref: "e2", role: "button", label: "Sign in" },
  ],
  signals: { passwordField: true, paymentField: false },
};

const routeInput: RouteSnapshotInput = {
  requestText: "sign in to my account",
  origin: "https://bank.example",
  elements: classifyInput.elements,
};

function recordRequests(answers: unknown): unknown[] {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe(JEV_API_URL);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      model: JEV_MODEL,
      answers,
      usage: { input_tokens: 120, output_tokens: 4 },
    });
  }) as typeof fetch;
  return bodies;
}

describe("Jev page classification", () => {
  it("registers both page hooks", () => {
    const handlers = registerHandlers();
    expect(handlers.has("classify.page")).toBe(true);
    expect(handlers.has("route.snapshot")).toBe(true);
  });

  it("asks one probability question per flag and returns each answer", async () => {
    const bodies = recordRequests({
      credential_entry: { type: "noul", noul: 0.97 },
      payment: { type: "noul", noul: 0.02 },
      captcha: { type: "noul", noul: 0.01 },
      agent_directed: { type: "noul", noul: 0.03 },
    });
    const result = (await registerHandlers().get("classify.page")?.(classifyInput, {
      signal,
    })) as ClassifyPageOutcome;
    expect(result).toEqual({
      status: "answered",
      flags: [
        { flag: "credential-entry", probability: 0.97 },
        { flag: "payment", probability: 0.02 },
        { flag: "captcha", probability: 0.01 },
        { flag: "agent-directed-instructions", probability: 0.03 },
      ],
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys((bodies[0] as { questions: object }).questions)).toEqual([
      "credential_entry",
      "payment",
      "captcha",
      "agent_directed",
    ]);
  });

  it("sends the origin, title, element roles and labels, and the two structural booleans only", async () => {
    const bodies = recordRequests({ credential_entry: { type: "noul", noul: 0.5 } });
    const hostileInput = {
      ...classifyInput,
      url: `https://bank.example${URL_PATH_SENTINEL}`,
      pageText: PAGE_BODY_SENTINEL,
      elements: classifyInput.elements.map((element) => ({
        ...element,
        value: PAGE_BODY_SENTINEL,
      })),
      signals: { ...classifyInput.signals, bodyHtml: PAGE_BODY_SENTINEL },
    } as ClassifyPageInput;
    await registerHandlers().get("classify.page")?.(hostileInput, { signal });
    const sent = JSON.stringify(bodies[0]);
    expect(sent).not.toContain(PAGE_BODY_SENTINEL);
    expect(sent).not.toContain("SECRET-IN-URL");
    expect(sent).not.toContain("/account/reset");
    expect((bodies[0] as { state: unknown }).state).toEqual({
      origin: "https://bank.example",
      title: "Sign in",
      elements: [
        { role: "textbox", label: "Password" },
        { role: "button", label: "Sign in" },
      ],
      signals: { passwordField: true, paymentField: false },
    });
  });

  it("abstains when Jev answers no question", async () => {
    recordRequests({});
    const result = await registerHandlers().get("classify.page")?.(classifyInput, { signal });
    expect(result?.status).toBe("abstained");
  });

  it("abstains when the provider fails", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await registerHandlers().get("classify.page")?.(classifyInput, { signal });
    expect(result?.status).toBe("abstained");
  });

  it("abstains on a page too large to send", async () => {
    const bodies = recordRequests({});
    const oversized = {
      ...classifyInput,
      title: "t".repeat(70_000),
    };
    const result = await registerHandlers().get("classify.page")?.(oversized, { signal });
    expect(result?.status).toBe("abstained");
    expect(bodies).toHaveLength(0);
  });
});

describe("Jev snapshot routing", () => {
  it("maps the choice distribution back onto refs and includes no-element", async () => {
    const bodies = recordRequests({
      first_element: {
        type: "choice",
        choice: "element_1",
        probabilities: { no_element: 0.1, element_0: 0.2, element_1: 0.7 },
        confidence: 0.8,
      },
    });
    const result = (await registerHandlers().get("route.snapshot")?.(routeInput, {
      signal,
    })) as RouteSnapshotOutcome;
    expect(result).toEqual({
      status: "answered",
      distribution: {
        noElementProbability: 0.1,
        elements: [
          { ref: "e1", probability: 0.2 },
          { ref: "e2", probability: 0.7 },
        ],
      },
    });
    expect(bodies).toHaveLength(1);
  });

  it("sends the request, origin, and element roles and labels only", async () => {
    const bodies = recordRequests({});
    const hostileInput = {
      ...routeInput,
      pageText: PAGE_BODY_SENTINEL,
      elements: routeInput.elements.map((element) => ({ ...element, href: URL_PATH_SENTINEL })),
    } as RouteSnapshotInput;
    await registerHandlers().get("route.snapshot")?.(hostileInput, { signal });
    const sent = JSON.stringify(bodies[0]);
    expect(sent).not.toContain(PAGE_BODY_SENTINEL);
    expect(sent).not.toContain("SECRET-IN-URL");
    expect((bodies[0] as { state: unknown }).state).toEqual({
      request: "sign in to my account",
      origin: "https://bank.example",
      elements: [
        { role: "textbox", label: "Password" },
        { role: "button", label: "Sign in" },
      ],
    });
  });

  it("abstains when there is nothing to route or too many elements", async () => {
    const bodies = recordRequests({});
    const handler = registerHandlers().get("route.snapshot");
    expect((await handler?.({ ...routeInput, elements: [] }, { signal }))?.status).toBe(
      "abstained",
    );
    const many = Array.from({ length: 300 }, (_, index) => ({
      ref: `e${index}`,
      role: "button",
      label: `b${index}`,
    }));
    expect((await handler?.({ ...routeInput, elements: many }, { signal }))?.status).toBe(
      "abstained",
    );
    expect(bodies).toHaveLength(0);
  });

  it("abstains when Jev omits the no-element probability", async () => {
    recordRequests({
      first_element: {
        type: "choice",
        choice: "element_0",
        probabilities: { element_0: 0.6, element_1: 0.4 },
        confidence: 0.6,
      },
    });
    const result = await registerHandlers().get("route.snapshot")?.(routeInput, { signal });
    expect(result?.status).toBe("abstained");
  });
});
