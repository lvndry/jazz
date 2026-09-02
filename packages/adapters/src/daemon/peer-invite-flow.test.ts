/**
 * @fileoverview Two jazz agents on localhost, becoming peers by invite rather than by hand.
 *
 * This is the scenario `docs/guide/peers-setup.md`'s "one machine, two agents" walkthrough
 * describes manually (edit config, `openssl rand`, `set-token` twice) — exercised here through
 * the real daemon handler factories, proving the two things that are actually new and risky
 * about the invite path: the redemption HTTP round-trip itself, and that the *same, already
 * running* `/peer/ask` handler recognizes the token an invite minted without a restart — the
 * live-reload fix `makePeerHandler` needed once invites could write config mid-process.
 *
 * What this does not (and cannot deterministically) prove: that Bob's agent produces a
 * correct English answer, which needs a real LLM. See `scripts/peers/two-agents-localhost.sh` for
 * the same scenario run with real agents end to end.
 */

import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import type { AppConfig } from "@jazz/core/types/config";
import { StorageNotFoundError } from "@jazz/core/types/errors";
import type { PeerConfig } from "@jazz/core/types/peer";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createInvite, type KeyringDependency } from "@/adapters/peers/invites";
import { peerTokenPath } from "@/adapters/secrets/registry";
import { makePeerHandler, makePeerInviteHandler, type DaemonRequirements } from "./server";

let jazzHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-daemon-invite-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await nodeFs.rm(jazzHome, { recursive: true, force: true });
});

/** Same fake as `invites.test.ts` — an in-memory OS keyring, never the real one. */
function fakeKeyring() {
  const store = new Map<string, string>();
  const dependency: KeyringDependency = {
    detectBackend: () => Effect.succeed("macos"),
    storeToken: (_backend, account, token) =>
      Effect.sync(() => {
        store.set(account, token);
        return true;
      }),
  };
  return { dependency, get: (account: string) => store.get(account) };
}

/** Alice's config, mutable exactly the way `AgentConfigService.set` mutates the real one. */
function fakeConfigLayer() {
  let peers: readonly PeerConfig[] = [];
  let revision = 0;
  const service: AgentConfigService = {
    get: () => Effect.dieMessage("not implemented"),
    getOrElse: <A>(_key: string, fallback: A) => Effect.succeed(fallback),
    getOrFail: () => Effect.dieMessage("not implemented"),
    has: () => Effect.succeed(false),
    set: <A>(key: string, value: A) =>
      Effect.sync(() => {
        if (key === "peers") peers = value as unknown as readonly PeerConfig[];
        revision += 1;
      }),
    revision: Effect.sync(() => revision),
    secretStorageUnavailable: () => false,
    reloadIfChanged: () => Effect.succeed(false),
    appConfig: Effect.sync((): AppConfig => ({ ...({} as AppConfig), peers })),
  };
  return { layer: Layer.succeed(AgentConfigServiceTag, service) };
}

/**
 * A `getAgentByIdentifier("alice")` that fails cleanly with `StorageNotFoundError` rather than
 * an unhandled "no `AgentService` in context" defect — which is what would otherwise happen
 * the moment `afterAccept`'s authorized request reaches `answerPeer`. Failing to find an agent
 * is a perfectly good, catchable outcome for what this test is actually checking (whether the
 * *token* is recognized), and stops well short of needing a real model.
 */
function fakeAgentServiceLayer(): Layer.Layer<AgentService> {
  const service: Partial<AgentService> = {
    getAgent: (identifier: string) =>
      Effect.fail(new StorageNotFoundError({ path: `agents/${identifier}` })),
    listAgents: () => Effect.succeed([]),
  };
  return Layer.succeed(AgentServiceTag, service as AgentService);
}

function runnerFor(layer: Layer.Layer<AgentConfigService | AgentService>) {
  return <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);
}

const ALICE_ASK_URL = "http://127.0.0.1:4747/peer/ask";

describe("two jazz agents on localhost, invited rather than hand-configured", () => {
  it("lets alice's already-running daemon authorize bob the moment he accepts — no restart", async () => {
    // --- Alice: `jazz peers invite create bob --disclosure internal` ---
    const created = await Effect.runPromise(
      createInvite({
        inviteeName: "bob",
        inviterDisplayName: "alice",
        inviterAskUrl: ALICE_ASK_URL,
        proposedTier: "internal",
        ttlMs: 60_000,
      }),
    );

    // Alice's daemon, wired the same way `daemon.ts` wires it: `resolvePeers` reads live
    // config on every request (the fix this feature needed), `resolveToken` reads wherever
    // this test keeps tokens (the fake keyring below, standing in for the real one).
    const { layer } = fakeConfigLayer();
    const keyring = fakeKeyring();
    const run = runnerFor(Layer.merge(layer, fakeAgentServiceLayer()));
    const resolvePeers = () =>
      run(
        Effect.gen(function* () {
          const service = yield* AgentConfigServiceTag;
          const appConfig = yield* service.appConfig;
          return appConfig.peers ?? [];
        }),
      );
    const handleInvite = makePeerInviteHandler(run, keyring.dependency, "alice");
    const handlePeer = makePeerHandler(
      { port: 4747, host: "127.0.0.1", peerAgent: "alice" },
      resolvePeers,
      (peerName) => Promise.resolve(keyring.get(peerTokenPath(peerName))),
      run,
    );

    // --- Bob: `jazz peers invite accept <link>` step 1, the unauthenticated preview ---
    const previewResponse = await handleInvite(
      new Request(`http://127.0.0.1:4747/peer-invites/${created.record.id}`),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      ok: boolean;
      status: string;
      inviterDisplayName: string;
      inviterAskUrl: string;
    };
    expect(preview.status).toBe("active");
    expect(preview.inviterDisplayName).toBe("alice");
    expect(preview.inviterAskUrl).toBe(ALICE_ASK_URL);

    // Before acceptance, alice's daemon has never heard of bob — any presented token is
    // rejected, because there is no peer entry yet for it to identify.
    const beforeAccept = await handlePeer(
      new Request(ALICE_ASK_URL, {
        method: "POST",
        headers: { authorization: "Bearer guess", "content-type": "application/json" },
        body: JSON.stringify({ question: "what time is it?" }),
      }),
    );
    expect(beforeAccept.status).toBe(401);

    // --- Bob: `jazz peers invite accept` step 2, the actual redemption ---
    const acceptResponse = await handleInvite(
      new Request(`http://127.0.0.1:4747/peer-invites/${created.record.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: created.secret, as: "bob" }),
      }),
    );
    expect(acceptResponse.status).toBe(200);
    const acceptBody = (await acceptResponse.json()) as {
      ok: boolean;
      token: string;
      inviterAskUrl: string;
    };
    expect(acceptBody.ok).toBe(true);
    expect(acceptBody.inviterAskUrl).toBe(ALICE_ASK_URL);

    // A second accept must not succeed — this is the single-use guarantee, exercised through
    // the actual HTTP route rather than `redeemInvite` directly.
    const secondAccept = await handleInvite(
      new Request(`http://127.0.0.1:4747/peer-invites/${created.record.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: created.secret, as: "bob" }),
      }),
    );
    expect(secondAccept.status).toBe(410);

    // --- The point of the whole feature: the SAME handlePeer closure, built before any of
    // this happened, now recognizes bob's freshly minted token without anything having been
    // restarted. ---
    const afterAccept = await handlePeer(
      new Request(ALICE_ASK_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${acceptBody.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "what time is it?" }),
      }),
    );
    // Answering the question needs a real agent stack this test does not stand up (see the
    // file-level comment) — what matters here is that authorization succeeded: neither a 401
    // (unknown token) nor a 404 (peer/ask not being served at all).
    expect(afterAccept.status).not.toBe(401);
    expect(afterAccept.status).not.toBe(404);

    // A token from a *wrong* guess must still fail, even after a real one exists — the door
    // identifies its caller, it does not merely admit anyone who asks nicely.
    const wrongToken = await handlePeer(
      new Request(ALICE_ASK_URL, {
        method: "POST",
        headers: { authorization: "Bearer not-bobs-token", "content-type": "application/json" },
        body: JSON.stringify({ question: "what time is it?" }),
      }),
    );
    expect(wrongToken.status).toBe(401);
  });

  it("refuses a bad secret without ever authorizing anything", async () => {
    const created = await Effect.runPromise(
      createInvite({
        inviteeName: "bob",
        inviterDisplayName: "alice",
        inviterAskUrl: ALICE_ASK_URL,
        proposedTier: "internal",
        ttlMs: 60_000,
      }),
    );
    const { layer } = fakeConfigLayer();
    const run = runnerFor(Layer.merge(layer, fakeAgentServiceLayer()));
    const handleInvite = makePeerInviteHandler(run, fakeKeyring().dependency, "alice");

    const response = await handleInvite(
      new Request(`http://127.0.0.1:4747/peer-invites/${created.record.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "wrong-secret", as: "bob" }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
