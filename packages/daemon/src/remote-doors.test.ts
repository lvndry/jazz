/**
 * @fileoverview The limits every remote door holds: how a webhook proves who sent it, that a
 * delivery runs once, how many runs a door may have in flight, how big a body may be, and what a
 * failure tells a caller who is not the operator.
 *
 * Driven through the handlers with no model behind them: the runner is either never reached or
 * replaced by a function that answers or fails on cue.
 */

import { createHmac } from "node:crypto";
import type { DeliveryClaim } from "@jazz/adapters/webhooks/deliveries";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import type { PeerConfig } from "@jazz/core/types/peer";
import type { WebhookConfig } from "@jazz/core/types/webhook";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  DoorConcurrency,
  makeA2AHandler,
  makePeerHandler,
  makeWebhookHandler,
  tokenMatches,
  webhookDeliveryKeys,
  webhookSignatureValid,
  type DaemonRequirements,
} from "./server";

const SECRET = "shared-signing-secret";

const GITHUB_SIGNATURE = { format: "hmac-sha256" } as const;

const SIGNED: WebhookConfig = {
  name: "gh",
  agentId: "default",
  promptTemplate: "Summarize {{payload}}",
  signature: GITHUB_SIGNATURE,
};

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers, body });
}

/** A daemon that is not paused. */
const OPEN = async () => undefined;

/** A runner that answers without running anything, so reaching it is the assertion. */
const REACHED = async () => new Response("reached the runner", { status: 299 }) as never;

/** An in-memory delivery record with the same all-or-nothing rule as the file one. */
function memoryDeliveries() {
  const seen = new Set<string>();
  return async (_webhookName: string, keys: readonly string[]): Promise<DeliveryClaim> => {
    if (keys.some((key) => seen.has(key))) {
      return "duplicate";
    }
    for (const key of keys) {
      seen.add(key);
    }
    return "fresh";
  };
}

function signedHandler(overrides: { readonly secret?: string | undefined } = {}) {
  return makeWebhookHandler(
    async () => [SIGNED],
    async () => {
      throw new Error("a signed webhook must not look up a bearer token");
    },
    REACHED,
    {
      resolveSecret: async () => ("secret" in overrides ? overrides.secret : SECRET),
      claimDelivery: memoryDeliveries(),
      pausedRefusal: OPEN,
    },
  );
}

describe("a webhook signed by its sender", () => {
  it("runs a body whose signature matches", async () => {
    const body = '{"action":"opened"}';
    const response = await signedHandler()(
      post("/webhooks/gh", body, { "x-hub-signature-256": sign(body) }),
    );
    expect(response.status).toBe(299);
  });

  it("refuses a body signed with another secret", async () => {
    const body = '{"action":"opened"}';
    const response = await signedHandler()(
      post("/webhooks/gh", body, { "x-hub-signature-256": sign(body, "guessed") }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a body changed after it was signed", async () => {
    const response = await signedHandler()(
      post("/webhooks/gh", '{"action":"deleted"}', {
        "x-hub-signature-256": sign('{"action":"opened"}'),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a request with no signature, whatever bearer token it carries", async () => {
    const response = await signedHandler()(
      post("/webhooks/gh", "{}", { authorization: "Bearer anything" }),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed when the secret is missing on this machine", async () => {
    const body = "{}";
    const response = await signedHandler({ secret: undefined })(
      post("/webhooks/gh", body, { "x-hub-signature-256": sign(body) }),
    );
    expect(response.status).toBe(401);
  });

  it("reads a custom header and prefix", () => {
    const body = new TextEncoder().encode("payload");
    const digest = createHmac("sha256", SECRET).update(body).digest("hex");
    const custom = { format: "hmac-sha256", header: "x-signature", prefix: "" } as const;

    expect(webhookSignatureValid(custom, SECRET, body, digest)).toBe(true);
    expect(webhookSignatureValid(custom, SECRET, body, `sha256=${digest}`)).toBe(false);
    expect(webhookSignatureValid(custom, SECRET, body, digest.slice(0, 63))).toBe(false);
  });

  it("verifies the exact bytes sent, not their decoded text", () => {
    // Invalid UTF-8 decodes to U+FFFD, so a signature over decoded text would not match what
    // the sender signed.
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
    const signature = `sha256=${createHmac("sha256", SECRET).update(bytes).digest("hex")}`;

    expect(webhookSignatureValid(GITHUB_SIGNATURE, SECRET, bytes, signature)).toBe(true);
  });
});

describe("a delivery that arrives twice", () => {
  it("runs the first and refuses the second with the same delivery id", async () => {
    const handle = signedHandler();
    const body = '{"n":1}';
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "d-1" };

    expect((await handle(post("/webhooks/gh", body, headers))).status).toBe(299);
    const again = await handle(post("/webhooks/gh", body, headers));
    expect(again.status).toBe(409);
  });

  it("refuses a captured request replayed under a fresh delivery id", async () => {
    // GitHub does not sign its delivery id, so only the signature ties a replay to the original.
    const handle = signedHandler();
    const body = '{"n":2}';
    await handle(
      post("/webhooks/gh", body, { "x-hub-signature-256": sign(body), "x-github-delivery": "d-2" }),
    );
    const replay = await handle(
      post("/webhooks/gh", body, { "x-hub-signature-256": sign(body), "x-github-delivery": "d-3" }),
    );
    expect(replay.status).toBe(409);
  });

  it("dedupes an unsigned webhook by its configured delivery header", () => {
    const webhook: WebhookConfig = {
      name: "relay",
      agentId: "default",
      promptTemplate: "{{payload}}",
      deliveryIdHeader: "x-request-id",
    };
    const keys = webhookDeliveryKeys(
      webhook,
      new Headers({ "x-request-id": "r-7", "x-github-delivery": "ignored" }),
    );
    expect(keys).toEqual(["delivery:r-7"]);
  });

  it("does not spend a delivery id on a request refused for a bad header", async () => {
    const handle = signedHandler();
    const body = "{}";
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "d-4" };

    const refused = await handle(
      post("/webhooks/gh", body, { ...headers, "x-jazz-progress-url": "https://example.com" }),
    );
    expect(refused.status).toBe(400);
    expect((await handle(post("/webhooks/gh", body, headers))).status).toBe(299);
  });
});

describe("a delivery that arrives while the daemon is paused", () => {
  it("is refused without being claimed, so it runs once the daemon resumes", async () => {
    let paused = true;
    const handle = makeWebhookHandler(
      async () => [SIGNED],
      async () => undefined,
      REACHED,
      {
        resolveSecret: async () => SECRET,
        claimDelivery: memoryDeliveries(),
        pausedRefusal: async () => (paused ? new Response("paused", { status: 503 }) : undefined),
      },
    );
    const body = '{"n":5}';
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "d-5" };

    expect((await handle(post("/webhooks/gh", body, headers))).status).toBe(503);
    paused = false;
    expect((await handle(post("/webhooks/gh", body, headers))).status).toBe(299);
  });
});

describe("which webhooks exist", () => {
  it("is not revealed by the answer to an unknown name", async () => {
    const handle = makeWebhookHandler(
      async () => [{ name: "deploys", agentId: "default", promptTemplate: "{{payload}}" }],
      async () => "right-token",
      REACHED,
    );
    const unknown = await handle(
      post("/webhooks/nope", "{}", { authorization: "Bearer right-token" }),
    );
    const badToken = await handle(post("/webhooks/deploys", "{}", { authorization: "Bearer no" }));

    expect(unknown.status).toBe(badToken.status);
    expect(await unknown.text()).toBe(await badToken.text());
  });
});

/** A runner whose AgentService fails with a message a caller must never see. */
function failingRunner() {
  const agents = {
    getAgent: () => Effect.fail(new Error("cannot read /Users/operator/.jazz/agents/x.json")),
  } as unknown as AgentService;
  return <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(AgentServiceTag, agents)) as Effect.Effect<A, never, never>,
    );
}

describe("a failure seen from outside", () => {
  it("tells a webhook caller the run failed, and nothing about why", async () => {
    const handle = makeWebhookHandler(
      async () => [{ name: "deploys", agentId: "default", promptTemplate: "{{payload}}" }],
      async () => "token",
      failingRunner(),
      { claimDelivery: async () => "fresh", pausedRefusal: OPEN },
    );
    const response = await handle(
      post("/webhooks/deploys", "{}", { authorization: "Bearer token" }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "the run failed" });
  });

  it("tells a peer it could not answer, and nothing about why", async () => {
    const handle = makePeerHandler(
      { port: 0, host: "127.0.0.1", peerAgent: "default" },
      async () => [SAM],
      async () => "sam-token",
      failingRunner(),
    );
    const response = await handle(peerRequest("/peer/ask", { question: "free tomorrow?" }));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/Users/operator");
  });

  it("answers an A2A caller with a bare internal error", async () => {
    const handle = makeA2AHandler(
      { port: 0, host: "127.0.0.1", peerAgent: "default" },
      async () => [SAM],
      async () => "sam-token",
      failingRunner(),
    );
    const response = await handle(
      peerRequest("/a2a", { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }),
    );
    const body = await response.text();

    expect(body).toContain("internal error");
    expect(body).not.toContain("/Users/operator");
  });
});

const SAM: PeerConfig = { name: "sam", disclosure: "public", maxConcurrentRuns: 1 };

function peerRequest(path: string, body: unknown, size?: number): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: "Bearer sam-token", "content-type": "application/json" },
    body: size === undefined ? JSON.stringify(body) : "x".repeat(size),
  });
}

describe("a peer's body", () => {
  const options = { port: 0, host: "127.0.0.1", peerAgent: "default" };
  const never = async () => {
    throw new Error("an oversized body must not reach the runner");
  };

  it("is refused past the cap on /peer/ask", async () => {
    const handle = makePeerHandler(
      options,
      async () => [SAM],
      async () => "sam-token",
      never,
    );
    expect((await handle(peerRequest("/peer/ask", undefined, 64_001))).status).toBe(413);
  });

  it("is refused past the cap on /a2a", async () => {
    const handle = makeA2AHandler(
      options,
      async () => [SAM],
      async () => "sam-token",
      never,
    );
    expect((await handle(peerRequest("/a2a", undefined, 64_001))).status).toBe(413);
  });
});

describe("how many runs a door may have in flight", () => {
  it("answers 429 past the cap and admits again once a run finishes", async () => {
    let finish: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const concurrency = new DoorConcurrency();
    const handle = makePeerHandler(
      { port: 0, host: "127.0.0.1", peerAgent: "default" },
      async () => [SAM],
      async () => "sam-token",
      async () => {
        await running;
        return new Response("answered", { status: 299 }) as never;
      },
      concurrency,
    );

    const first = handle(peerRequest("/peer/ask", { question: "one" }));
    await Promise.resolve();
    const second = await handle(peerRequest("/peer/ask", { question: "two" }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();

    finish?.();
    expect((await first).status).toBe(299);
    expect((await handle(peerRequest("/peer/ask", { question: "three" }))).status).toBe(299);
  });

  it("counts a peer once across /peer/ask and /a2a", () => {
    const concurrency = new DoorConcurrency();
    const release = concurrency.tryEnter("peer:sam", 1);

    expect(release).toBeDefined();
    expect(concurrency.tryEnter("peer:sam", 1)).toBeUndefined();
    expect(concurrency.tryEnter("peer:ada", 1)).toBeDefined();
    release?.();
    expect(concurrency.tryEnter("peer:sam", 1)).toBeDefined();
  });

  it("caps a webhook by its own setting", async () => {
    const concurrency = new DoorConcurrency();
    const occupied = concurrency.tryEnter("webhook:deploys", 1);
    const handle = makeWebhookHandler(
      async () => [
        {
          name: "deploys",
          agentId: "default",
          promptTemplate: "{{payload}}",
          maxConcurrentRuns: 1,
        },
      ],
      async () => "token",
      REACHED,
      { claimDelivery: async () => "fresh", concurrency, pausedRefusal: OPEN },
    );

    const response = await handle(
      post("/webhooks/deploys", "{}", { authorization: "Bearer token" }),
    );
    expect(response.status).toBe(429);
    occupied?.();
  });
});

describe("comparing a presented credential", () => {
  it("matches only the exact value", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
  });
});
