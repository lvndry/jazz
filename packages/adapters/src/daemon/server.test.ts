import path from "node:path";
import { createRunRecord } from "@jazz/core/agent/run/run-record";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { WebhookConfig } from "@jazz/core/types/webhook";
import { getJazzHomeDirectory, getWorkStateDirectory } from "@jazz/core/utils/paths";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { InMemoryRunStore } from "@/adapters/storage/run-store";
import {
  makeHandler,
  makePeerInviteHandler,
  makeWebhookHandler,
  refuseReason,
  webhookConversationId,
  type DaemonRequirements,
} from "./server";

const LOOPBACK = { port: 0, host: "127.0.0.1" };

/**
 * Runs a handler effect against a store, with no agent stack behind it.
 *
 * The route-level behaviour under test — auth, method matching, run lookup — never reaches
 * the runner, so nothing here has to stand up an LLM.
 */
function runnerFor(store: InMemoryRunStore) {
  return <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(RunStoreTag, store)) as Effect.Effect<A, never, never>,
    );
}

function request(method: string, path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, { method, ...init });
}

describe("refusing an unsafe bind", () => {
  it("allows loopback without a token", () => {
    expect(refuseReason(LOOPBACK)).toBeUndefined();
  });

  it("refuses a public interface with no token, and says why", () => {
    const reason = refuseReason({ port: 4747, host: "0.0.0.0" });
    expect(reason).toContain("Refusing to bind");
    expect(reason).toContain("filesystem access");
  });

  it("allows a public interface once a token is set", () => {
    expect(refuseReason({ port: 4747, host: "0.0.0.0", token: "s3cret" })).toBeUndefined();
  });

  it("treats an empty token as no token", () => {
    expect(refuseReason({ port: 4747, host: "0.0.0.0", token: "" })).toContain("Refusing");
  });
});

describe("the daemon's routes", () => {
  it("does not expose invite redemption unless the daemon is serving peers", async () => {
    const handle = makePeerInviteHandler(async () => {
      throw new Error("the disabled route must not run an effect");
    });

    const response = await handle(request("GET", "/peer-invites/00000000000000000000000000000000"));
    expect(response.status).toBe(404);
  });

  it("caps unauthenticated invite redemption bodies before parsing JSON", async () => {
    const handle = makePeerInviteHandler(
      async () => {
        throw new Error("an oversized body must not run an effect");
      },
      undefined,
      "alice",
    );
    const response = await handle(
      request("POST", "/peer-invites/00000000000000000000000000000000/accept", {
        body: "x".repeat(20_001),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("answers health without a credential, so a supervisor need not hold one", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerFor(store));

    const response = await handle(request("GET", "/health"));
    expect(response.status).toBe(200);
  });

  it("rejects an unauthenticated request when a token is configured", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerFor(store));

    const response = await handle(request("GET", "/runs"));
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerFor(store));

    const response = await handle(
      request("GET", "/runs", { headers: { authorization: "Bearer wrong!" } }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the right token", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerFor(store));

    const response = await handle(
      request("GET", "/runs", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(response.status).toBe(200);
  });

  it("serves a run that exists, from the store the CLI writes to", async () => {
    const store = new InMemoryRunStore();
    const record = createRunRecord({
      runId: "11111111-2222-3333-4444-555555555555",
      agentId: "assistant",
      conversationId: "conv-1",
      input: "push the branch",
      now: new Date("2026-08-23T10:00:00Z"),
    });
    await Effect.runPromise(store.save(record));

    const handle = makeHandler(LOOPBACK, runnerFor(store));
    const response = await handle(request("GET", `/runs/${record.runId}`));
    const body = (await response.json()) as { ok: boolean; run: { input: string } };

    expect(response.status).toBe(200);
    expect(body.run.input).toBe("push the branch");
  });

  it("404s a run that does not exist rather than inventing one", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler(LOOPBACK, runnerFor(store));

    const response = await handle(request("GET", "/runs/does-not-exist"));
    expect(response.status).toBe(404);
  });

  it("requires an agent and a prompt to start a run", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler(LOOPBACK, runnerFor(store));

    const response = await handle(
      request("POST", "/runs", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON rather than throwing", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler(LOOPBACK, runnerFor(store));

    const response = await handle(request("POST", "/runs", { body: "not json" }));
    expect(response.status).toBe(400);
  });

  it("404s an unknown path", async () => {
    const store = new InMemoryRunStore();
    const handle = makeHandler(LOOPBACK, runnerFor(store));

    expect((await handle(request("GET", "/nope"))).status).toBe(404);
  });

  it("rejects an oversized webhook body while it is being read", async () => {
    const handle = makeWebhookHandler(
      [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/hook", {
        headers: { authorization: "Bearer webhook-secret" },
        body: "x".repeat(20_001),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("returns 404 for malformed webhook URL encoding", async () => {
    const handle = makeWebhookHandler(
      [],
      async () => undefined,
      async () => {
        throw new Error("runEffect should not be called");
      },
    );
    expect((await handle(request("POST", "/webhooks/%E0%A4%A"))).status).toBe(404);
  });

  it("refuses a thread key on a webhook that is not threaded", async () => {
    const handle = makeWebhookHandler(
      [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/hook", {
        headers: { authorization: "Bearer webhook-secret", "x-jazz-thread": "room-7" },
        body: "hello",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not threaded");
  });

  it("refuses a thread key longer than the cap", async () => {
    const handle = makeWebhookHandler(
      [
        {
          name: "hook",
          agentId: "default",
          promptTemplate: "Process {{payload}}",
          conversation: "threaded",
        },
      ],
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/hook", {
        headers: { authorization: "Bearer webhook-secret", "x-jazz-thread": "k".repeat(201) },
        body: "hello",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("too long");
  });

  it("still routes the pre-rename /triggers/<name> URL to the same webhook", async () => {
    const handle = makeWebhookHandler(
      [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    // A 401 rather than a 404 is the assertion: the legacy path matched the route and found
    // the webhook, and only the missing bearer token stopped it.
    expect((await handle(request("POST", "/triggers/hook", { body: "hello" }))).status).toBe(401);
    expect((await handle(request("POST", "/triggers/nope", { body: "hello" }))).status).toBe(404);
  });
});

describe("which conversation a webhook fire belongs to", () => {
  const ephemeral: WebhookConfig = {
    name: "hook",
    agentId: "default",
    promptTemplate: "Process {{payload}}",
  };
  const threaded: WebhookConfig = { ...ephemeral, conversation: "threaded" };

  it("mints a fresh id per fire when the webhook is ephemeral", () => {
    const first = webhookConversationId(ephemeral, undefined);
    const second = webhookConversationId(ephemeral, undefined);

    expect(first).toStartWith("trigger-hook-");
    expect(second).not.toBe(first);
  });

  it("ignores nothing and still randomizes when an ephemeral webhook is given a key", () => {
    // The handler refuses this combination before it gets here; this pins the fallback so a
    // future caller that skips the handler cannot silently get a stable id it was denied.
    expect(webhookConversationId(ephemeral, "room-7")).not.toBe(
      webhookConversationId(ephemeral, "room-7"),
    );
  });

  it("resumes the same conversation for one thread key", () => {
    expect(webhookConversationId(threaded, "room-7")).toBe("trigger-hook-room-7");
    expect(webhookConversationId(threaded, "room-7")).toBe(
      webhookConversationId(threaded, "room-7"),
    );
  });

  it("keeps separate thread keys in separate conversations", () => {
    expect(webhookConversationId(threaded, "room-7")).not.toBe(
      webhookConversationId(threaded, "room-8"),
    );
  });

  it("shares one thread across keyless fires rather than falling back to ephemeral", () => {
    expect(webhookConversationId(threaded, undefined)).toBe("trigger-hook");
    expect(webhookConversationId(threaded, undefined)).toBe(
      webhookConversationId(threaded, undefined),
    );
  });

  it("keeps a traversal attempt in the thread key out of the path it resolves to", () => {
    // The id itself carries the raw key — sanitization belongs to whoever builds a path from
    // it, so that the rule lives in one place. What must hold is that the resolved path
    // stays inside the work directory.
    const escaping = webhookConversationId(threaded, "../../../../etc/pwned");
    const resolved = path.resolve(getWorkStateDirectory("default", escaping));

    expect(resolved).toStartWith(path.resolve(getJazzHomeDirectory(), "work") + path.sep);
    expect(resolved).not.toContain("etc/pwned");
  });
});
