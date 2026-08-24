import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createRunRecord } from "@/core/agent/run/run-record";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { InMemoryRunStore } from "@/services/storage/run-store";
import { makeHandler, refuseReason, type DaemonRequirements } from "./server";

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
});
