import path from "node:path";
import { createRunRecord } from "@jazz/core/agent/run/run-record";
import { AVAILABLE_PROVIDERS } from "@jazz/core/constants/models";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { PersonaServiceTag } from "@jazz/core/interfaces/persona-service";
import type { PersonaService } from "@jazz/core/interfaces/persona-service";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { StorageService } from "@jazz/core/interfaces/storage";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import type { ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import { REASONING_EFFORTS } from "@jazz/core/types/agent";
import type { Agent } from "@jazz/core/types/agent";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/types/config";
import { StorageNotFoundError } from "@jazz/core/types/errors";
import { isLoopbackProgressUrl, parseProgressEvents } from "@jazz/core/types/webhook";
import type { WebhookConfig } from "@jazz/core/types/webhook";
import { getJazzHomeDirectory, getWorkStateDirectory } from "@jazz/core/utils/paths";
import { describe, expect, it } from "bun:test";
import { Context, Effect } from "effect";
import { AgentServiceImpl } from "@/adapters/agent-service";
import { InMemoryRunStore } from "@/adapters/storage/run-store";
import {
  makeA2AHandler,
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

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "uGS8WAv4cGBiFH1wHB7r4E",
    name: "sonnet",
    description: "everyday assistant",
    config: {
      persona: "default",
      llmProvider: "anthropic",
      llmModel: "claude-sonnet-4-6",
      tools: ["read_file", "http_request"],
      llmApiKeys: { anthropic: "sk-must-not-leak" },
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

/** Provides exactly the one service the route under test reaches for. */
function runnerProviding<S>(tag: Context.Tag<S, S>, service: S) {
  return <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(tag, service)) as Effect.Effect<A, never, never>,
    );
}

/** Only `listAgents` is reachable from the route under test. */
function runnerForAgents(agents: readonly Agent[]) {
  const service = { listAgents: () => Effect.succeed(agents) } as unknown as AgentService;
  return <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(AgentServiceTag, service)) as Effect.Effect<
        A,
        never,
        never
      >,
    );
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
      async () => [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/hook", {
        headers: { authorization: "Bearer webhook-secret" },
        body: "x".repeat(1_048_577),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("accepts a body the size of an ordinary webhook payload", async () => {
    // The old cap sat under a routine GitHub push event, so the door refused traffic it
    // exists to receive. Reaching the runner at all is the assertion — signalled by what the
    // runner returns rather than by throwing, so this says nothing about how the door treats
    // an exception.
    const handle = makeWebhookHandler(
      async () => [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
      async () => "webhook-secret",
      async () => new Response("reached the runner", { status: 299 }) as never,
    );

    const response = await handle(
      request("POST", "/webhooks/hook", {
        headers: { authorization: "Bearer webhook-secret" },
        body: "x".repeat(512_000),
      }),
    );
    expect(response.status).toBe(299);
  });

  it("returns 404 for malformed webhook URL encoding", async () => {
    const handle = makeWebhookHandler(
      async () => [],
      async () => undefined,
      async () => {
        throw new Error("runEffect should not be called");
      },
    );
    expect((await handle(request("POST", "/webhooks/%E0%A4%A"))).status).toBe(404);
  });

  it("sees a webhook added after the daemon started, without a restart", async () => {
    // The list is read per request, not captured once. A snapshot here would mean adding a
    // webhook silently did nothing until somebody bounced the process.
    const webhooks: { name: string; agentId: string; promptTemplate: string }[] = [];
    const handle = makeWebhookHandler(
      async () => webhooks,
      async () => "webhook-secret",
      async () => {
        throw new Error("runEffect should not be called");
      },
    );

    const before = await handle(
      request("POST", "/webhooks/late", {
        headers: { authorization: "Bearer webhook-secret" },
        body: "hello",
      }),
    );
    expect(before.status).toBe(404);

    webhooks.push({ name: "late", agentId: "default", promptTemplate: "Process {{payload}}" });

    // Now found, so authorization runs — the 401 here is the token check, not the lookup.
    const after = await handle(
      request("POST", "/webhooks/late", {
        headers: { authorization: "Bearer wrong" },
        body: "hello",
      }),
    );
    expect(after.status).toBe(401);
  });

  it("refuses a thread key on a webhook that is not threaded", async () => {
    const handle = makeWebhookHandler(
      async () => [{ name: "hook", agentId: "default", promptTemplate: "Process {{payload}}" }],
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
      async () => [
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
});

/**
 * The card is the only thing a peer reads before it knows where to send anything, so the
 * endpoint it names has to be an address that peer can actually reach. The daemon is told a
 * bind address, which is a different question — the documented way to be reachable at all is
 * a tunnel in front of a loopback bind.
 */
describe("the address an agent card tells a peer to call", () => {
  const cardHandler = (peerAgent?: string) =>
    makeA2AHandler(
      { ...LOOPBACK, peerAgent },
      async () => [],
      async () => undefined,
      async () => {
        throw new Error("fetching a card must not run an effect");
      },
    );

  async function advertisedUrl(headers: Record<string, string> = {}): Promise<string> {
    const response = await cardHandler("alice")(
      new Request("http://127.0.0.1:4321/.well-known/agent-card.json", { headers }),
    );
    const card = (await response.json()) as { supportedInterfaces: { url: string }[] };
    return card.supportedInterfaces[0]!.url;
  }

  it("names the address the card was fetched on when nothing is in front of it", async () => {
    expect(await advertisedUrl()).toBe("http://127.0.0.1:4321/a2a");
  });

  it("names the tunnel rather than a loopback address no peer could reach", async () => {
    const url = await advertisedUrl({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "me.example",
    });
    expect(url).toBe("https://me.example/a2a");
  });

  it("takes the first hop of a chain, which is the address the client used", async () => {
    const url = await advertisedUrl({
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "me.example, inner.internal",
    });
    expect(url).toBe("https://me.example/a2a");
  });

  it("is not served at all by a daemon that is not answering peers", async () => {
    const response = await cardHandler(undefined)(
      new Request("http://127.0.0.1:4321/.well-known/agent-card.json"),
    );
    expect(response.status).toBe(404);
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

describe("listing the agents a daemon can run", () => {
  it("answers with the fields somebody choosing between them needs", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([agentFixture()]));

    const response = await handle(request("GET", "/agents"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      agents: {
        id: string;
        name: string;
        description?: string;
        persona: string;
        provider: string;
        model: string;
        tools: string[];
      }[];
    };
    expect(body.ok).toBe(true);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toEqual({
      id: "uGS8WAv4cGBiFH1wHB7r4E",
      name: "sonnet",
      description: "everyday assistant",
      persona: "default",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tools: ["read_file", "http_request"],
    });
  });

  it("never hands out an agent's api keys", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([agentFixture()]));

    const response = await handle(request("GET", "/agents"));
    expect(await response.text()).not.toContain("sk-must-not-leak");
  });

  it("omits a description rather than sending an empty one", async () => {
    // Built without the field rather than with it set to undefined, which
    // exactOptionalPropertyTypes rightly refuses.
    const { description: _unused, ...withoutDescription } = agentFixture();
    const handle = makeHandler(LOOPBACK, runnerForAgents([withoutDescription]));

    const response = await handle(request("GET", "/agents"));
    const body = (await response.json()) as { agents: Record<string, unknown>[] };
    expect(body.agents[0]).not.toHaveProperty("description");
  });

  it("reports an agent with no tools as having none, not as missing a field", async () => {
    const bare = agentFixture({
      config: { persona: "default", llmProvider: "openai", llmModel: "gpt-5.4-mini" },
    } as Partial<Agent>);
    const handle = makeHandler(LOOPBACK, runnerForAgents([bare]));

    const response = await handle(request("GET", "/agents"));
    const body = (await response.json()) as { agents: { tools: string[] }[] };
    expect(body.agents[0]?.tools).toEqual([]);
  });

  it("needs the daemon token when one is configured, like every other route", async () => {
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerForAgents([agentFixture()]));

    expect((await handle(request("GET", "/agents"))).status).toBe(401);
    const authorized = await handle(
      request("GET", "/agents", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(authorized.status).toBe(200);
  });

  it("answers an empty list rather than a 404 when there are no agents", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    const response = await handle(request("GET", "/agents"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { agents: unknown[] }).agents).toEqual([]);
  });
});

describe("a webhook caller that wants to know what the run is doing", () => {
  it("accepts a loopback progress url", () => {
    for (const url of [
      "http://127.0.0.1:7777/progress",
      "http://localhost:7777/progress",
      "https://localhost:8443/progress",
      "http://[::1]:7777/progress",
    ]) {
      expect(isLoopbackProgressUrl(url), url).toBe(true);
    }
  });

  it("refuses anywhere else, so a caller cannot make jazz knock on doors for them", () => {
    for (const url of [
      "http://example.com/progress",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/progress",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      expect(isLoopbackProgressUrl(url), url).toBe(false);
    }
  });

  it("tells a caller its progress url was rejected rather than ignoring it", async () => {
    const webhook: WebhookConfig = {
      name: "quartet",
      agentId: "agt_1",
      promptTemplate: "{{payload}}",
    };
    const handle = makeWebhookHandler(
      async () => [webhook],
      async () => "hook-token",
      async () => {
        throw new Error("a rejected progress url must not reach the runner");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/quartet", {
        body: "{}",
        headers: {
          authorization: "Bearer hook-token",
          "x-jazz-progress-url": "http://example.com/steal",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("loopback");
  });
});

describe("choosing which progress events to receive", () => {
  it("treats a missing or empty list as every kind", () => {
    // Handing over a URL is already the act of subscribing; a caller that wants the lot
    // should not have to enumerate it.
    for (const raw of [null, "", "  ", ",,"]) {
      const parsed = parseProgressEvents(raw);
      if ("unknownKind" in parsed) throw new Error("expected kinds");
      expect(parsed.kinds.size, JSON.stringify(raw)).toBe(3);
    }
  });

  it("narrows to what was asked for", () => {
    const parsed = parseProgressEvents("approval-required, tool-started");
    if ("unknownKind" in parsed) throw new Error("expected kinds");

    expect([...parsed.kinds].sort()).toEqual(["approval-required", "tool-started"]);
    expect(parsed.kinds.has("tool-finished")).toBe(false);
  });

  it("names a kind it does not know rather than dropping it", () => {
    // A caller that misspelled one would otherwise wait forever for events never sent.
    const parsed = parseProgressEvents("tool-startd");
    expect(parsed).toEqual({ unknownKind: "tool-startd" });
  });

  it("refuses the fire, so the caller finds out before the run goes ahead", async () => {
    const webhook: WebhookConfig = {
      name: "quartet",
      agentId: "agt_1",
      promptTemplate: "{{payload}}",
    };
    const handle = makeWebhookHandler(
      async () => [webhook],
      async () => "hook-token",
      async () => {
        throw new Error("a bad subscription must not reach the runner");
      },
    );

    const response = await handle(
      request("POST", "/webhooks/quartet", {
        body: "{}",
        headers: {
          authorization: "Bearer hook-token",
          "x-jazz-progress-url": "http://127.0.0.1:7777/p",
          "x-jazz-progress-events": "tool-started,nonsense",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("nonsense");
  });
});

/**
 * A real `AgentServiceImpl` over a map, rather than a stubbed service.
 *
 * The write routes are thin on purpose — their whole job is to hand a body to the agent
 * service and turn its refusals into status codes — so a stub that cannot refuse anything
 * would test nothing. This exercises the validation the endpoints actually rely on.
 */
function runnerForWritableAgents(seed: readonly Agent[] = []) {
  const agents = new Map(seed.map((agent) => [agent.id, agent]));
  const storage = {
    listAgents: () => Effect.succeed([...agents.values()]),
    getAgent: (id: string) => {
      const found = agents.get(id);
      return found === undefined
        ? Effect.fail(new StorageNotFoundError({ path: id }))
        : Effect.succeed(found);
    },
    saveAgent: (agent: Agent) => {
      agents.set(agent.id, agent);
      return Effect.void;
    },
    deleteAgent: (id: string) => {
      agents.delete(id);
      return Effect.void;
    },
  } as unknown as StorageService;

  const service = new AgentServiceImpl(storage);
  const run = <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(AgentServiceTag, service)) as Effect.Effect<
        A,
        never,
        never
      >,
    );
  return { run, agents };
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("creating an agent over HTTP", () => {
  it("creates one and answers with its full config", async () => {
    const { run, agents } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("POST", "/agents", {
        name: "negotiator",
        description: "rehearses a hard conversation",
        config: { persona: "default", llmProvider: "anthropic", llmModel: "claude-sonnet-4-6" },
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      agent: { name: string; provider: string; config: { llmModel: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.agent.name).toBe("negotiator");
    expect(body.agent.provider).toBe("anthropic");
    expect(body.agent.config.llmModel).toBe("claude-sonnet-4-6");
    expect(agents.size).toBe(1);
  });

  it("names the offending field when the config is invalid, so a form can point at it", async () => {
    const { run } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("POST", "/agents", {
        name: "broken",
        config: { persona: "default", llmProvider: "gpt", llmModel: "gpt-4o" },
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { field: string; suggestion?: string };
    expect(body.field).toBe("config.llmProvider");
    expect(body.suggestion).toContain("anthropic");
  });

  it("refuses api keys rather than silently dropping them", async () => {
    const { run, agents } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("POST", "/agents", {
        name: "leaky",
        config: {
          persona: "default",
          llmProvider: "anthropic",
          llmModel: "claude-sonnet-4-6",
          llmApiKeys: { anthropic: "sk-should-not-be-stored" },
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("keyring");
    // The point of refusing over scrubbing: nothing was written, so the caller cannot
    // believe a key was saved when it was not.
    expect(agents.size).toBe(0);
  });

  it("reports a duplicate name as a conflict, not a validation error", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("POST", "/agents", {
        name: "sonnet",
        config: { persona: "default", llmProvider: "anthropic", llmModel: "claude-sonnet-4-6" },
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as { field: string }).toMatchObject({ field: "name" });
  });

  it("rejects a name the CLI would also reject", async () => {
    const { run } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("POST", "/agents", {
        name: "not a valid name!",
        config: { persona: "default", llmProvider: "anthropic", llmModel: "claude-sonnet-4-6" },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not a JSON object", async () => {
    const { run } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    expect((await handle(jsonRequest("POST", "/agents", ["nope"]))).status).toBe(400);
    expect(
      (
        await handle(
          new Request("http://localhost/agents", { method: "POST", body: "not json at all" }),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects a body larger than the operator cap before buffering it", async () => {
    const { run } = runnerForWritableAgents();
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      new Request("http://localhost/agents", {
        method: "POST",
        headers: { "content-length": "999999" },
        body: JSON.stringify({ name: "big" }),
      }),
    );

    expect(response.status).toBe(413);
  });

  it("needs the daemon token, like every other route", async () => {
    const { run } = runnerForWritableAgents();
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, run);

    const response = await handle(jsonRequest("POST", "/agents", { name: "nope" }));
    expect(response.status).toBe(401);
  });
});

describe("reading one agent over HTTP", () => {
  it("answers with the whole config an editor needs", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(request("GET", "/agents/uGS8WAv4cGBiFH1wHB7r4E"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agent: { config: Record<string, unknown>; apiKeyProviders: string[] };
    };
    expect(body.agent.config["tools"]).toEqual(["read_file", "http_request"]);
    expect(body.agent.config["llmProvider"]).toBe("anthropic");
  });

  it("says which providers have a per-agent key without handing the key out", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(request("GET", "/agents/uGS8WAv4cGBiFH1wHB7r4E"));
    const text = await response.text();
    expect(text).not.toContain("sk-must-not-leak");
    expect(JSON.parse(text) as { agent: { apiKeyProviders: string[] } }).toMatchObject({
      agent: { apiKeyProviders: ["anthropic"] },
    });
  });

  it("resolves an agent by name as well as by id", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(request("GET", "/agents/sonnet"));
    expect(response.status).toBe(200);
  });

  it("answers 404 for an agent that does not exist", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    expect((await handle(request("GET", "/agents/nobody"))).status).toBe(404);
  });
});

describe("updating an agent over HTTP", () => {
  it("merges the config rather than replacing it", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("PATCH", "/agents/uGS8WAv4cGBiFH1wHB7r4E", {
        config: { llmModel: "claude-opus-4-6" },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agent: { model: string; config: { tools: string[]; persona: string } };
    };
    expect(body.agent.model).toBe("claude-opus-4-6");
    // Untouched fields survive: this is what makes the route a PATCH.
    expect(body.agent.config.tools).toEqual(["read_file", "http_request"]);
    expect(body.agent.config.persona).toBe("default");
  });

  it("rejects an invalid value without writing anything", async () => {
    const { run, agents } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("PATCH", "/agents/uGS8WAv4cGBiFH1wHB7r4E", {
        config: { temperature: 9 },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { field: string }).toMatchObject({
      field: "config.temperature",
    });
    expect(agents.get("uGS8WAv4cGBiFH1wHB7r4E")?.config.temperature).toBeUndefined();
  });

  it("refuses api keys on update too", async () => {
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(
      jsonRequest("PATCH", "/agents/uGS8WAv4cGBiFH1wHB7r4E", {
        config: { llmApiKeys: { anthropic: "sk-nope" } },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 404 for an agent that does not exist", async () => {
    const { run } = runnerForWritableAgents([]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(jsonRequest("PATCH", "/agents/ghost", { name: "renamed" }));
    expect(response.status).toBe(404);
  });
});

describe("deleting an agent over HTTP", () => {
  it("removes it and reports the id it removed", async () => {
    const { run, agents } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(request("DELETE", "/agents/sonnet"));
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({
      id: "uGS8WAv4cGBiFH1wHB7r4E",
    });
    expect(agents.size).toBe(0);
  });

  it("answers 404 rather than pretending it deleted something", async () => {
    const { run } = runnerForWritableAgents([]);
    const handle = makeHandler(LOOPBACK, run);

    expect((await handle(request("DELETE", "/agents/ghost"))).status).toBe(404);
  });
});

describe("the operator door's auth boundary", () => {
  it("answers a public route without a credential", async () => {
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerForAgents([]));

    expect((await handle(request("GET", "/health"))).status).toBe(200);
  });

  it("hides whether an unknown path exists from a caller with no token", async () => {
    // 401 rather than 404 on purpose: if unmatched paths answered 404 while real ones
    // answered 401, anyone could map the door without holding the token.
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerForAgents([]));

    expect((await handle(request("GET", "/nothing-here"))).status).toBe(401);
  });

  it("hides a real path addressed with the wrong method just the same", async () => {
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerForAgents([]));

    expect((await handle(request("PUT", "/agents"))).status).toBe(401);
  });

  it("answers 404 for an unsupported method once the caller is authorized", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    expect((await handle(request("PUT", "/agents"))).status).toBe(404);
  });

  it("treats an undecodable path segment as an agent that does not exist", async () => {
    // A malformed escape is not special-cased: it decodes to something, that something
    // names no agent, and the answer is the same 404 any unknown name gets. What matters is
    // that it does not fault.
    const { run } = runnerForWritableAgents([agentFixture()]);
    const handle = makeHandler(LOOPBACK, run);

    const response = await handle(request("GET", "/agents/%E0%A4%A"));
    expect(response.status).toBe(404);
  });

  it("does not let a path param swallow a segment separator", async () => {
    // `:identifier` matches one segment, so this is a miss rather than an agent named
    // "a/b" — otherwise a nested route added later would be shadowed by this one.
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    expect((await handle(request("GET", "/agents/a/b"))).status).toBe(404);
  });
});

describe("the menus an agent editor is built from", () => {
  it("serves the same closed lists the validator enforces", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    const response = await handle(request("GET", "/catalog"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: string[];
      webSearchProviders: string[];
      reasoningEfforts: string[];
    };
    // Compared against the arrays themselves, so a provider added to jazz without being
    // served here — which would make the menu narrower than what is accepted — fails.
    expect(body.providers).toEqual([...AVAILABLE_PROVIDERS]);
    expect(body.webSearchProviders).toEqual([...WEB_SEARCH_PROVIDERS]);
    expect(body.reasoningEfforts).toEqual([...REASONING_EFFORTS]);
  });

  it("refuses to list models for a provider that is not one", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    const response = await handle(request("GET", "/models?provider=gpt"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { field: string; suggestion: string };
    expect(body.field).toBe("provider");
    expect(body.suggestion).toContain("anthropic");
  });

  it("refuses a model listing with no provider at all", async () => {
    const handle = makeHandler(LOOPBACK, runnerForAgents([]));

    expect((await handle(request("GET", "/models"))).status).toBe(400);
  });

  it("lists the personas an agent can be given, without their prompts", async () => {
    const personas = [
      {
        id: "builtin-default",
        name: "default",
        description: "the everyday one",
        systemPrompt: "a long prompt nobody picking a persona needs",
        tone: "neutral",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ];
    const service = { listPersonas: () => Effect.succeed(personas) } as unknown as PersonaService;
    const handle = makeHandler(LOOPBACK, runnerProviding(PersonaServiceTag, service));

    const response = await handle(request("GET", "/personas"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { personas: Record<string, unknown>[] };
    expect(body.personas[0]).toEqual({
      id: "builtin-default",
      name: "default",
      description: "the everyday one",
      tone: "neutral",
    });
    expect(body.personas[0]).not.toHaveProperty("systemPrompt");
  });

  it("lists pickable tools with their categories, and leaves hidden ones out", async () => {
    const registry = {
      // `listAllTools` is the one that includes hidden tools; using it here would offer a
      // caller something deliberately not offered, so the route must not reach for it.
      listTools: () => Effect.succeed(["read_file", "web_search"]),
      listAllTools: () => Effect.succeed(["read_file", "web_search", "ask_user"]),
      listToolsByCategory: () => Effect.succeed({ filesystem: ["read_file"], web: ["web_search"] }),
    } as unknown as ToolRegistry;
    const handle = makeHandler(LOOPBACK, runnerProviding(ToolRegistryTag, registry));

    const response = await handle(request("GET", "/tools"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tools: string[];
      categories: Record<string, string[]>;
    };
    expect(body.tools).toEqual(["read_file", "web_search"]);
    expect(body.tools).not.toContain("ask_user");
    expect(body.categories).toEqual({ filesystem: ["read_file"], web: ["web_search"] });
  });

  it("keeps the menus behind the daemon token", async () => {
    const handle = makeHandler({ ...LOOPBACK, token: "s3cret" }, runnerForAgents([]));

    for (const path of ["/catalog", "/models?provider=openai", "/personas", "/tools"]) {
      expect((await handle(request("GET", path))).status).toBe(401);
    }
  });
});

describe("a handler that faults", () => {
  it("answers a JSON 500 rather than letting the fault reach the socket", async () => {
    // Worth pinning because it changed: a bare async handler let a throw propagate out to
    // Bun.serve, and the door now catches it. The reply carries no detail — one of these
    // doors answers callers holding no credential — and the fault goes to stderr.
    const handle = makeHandler(LOOPBACK, () => {
      throw new Error("boom");
    });

    const response = await handle(request("GET", "/agents"));
    expect(response.status).toBe(500);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "internal error",
    });
  });
});
