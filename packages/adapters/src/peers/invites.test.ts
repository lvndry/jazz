import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { AppConfig } from "@jazz/core/types/config";
import type { PeerConfig } from "@jazz/core/types/peer";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import type { KeyringBackend } from "@/adapters/secrets/keyring";
import { peerTokenPath } from "@/adapters/secrets/registry";
import {
  acceptInviteOnInviterSide,
  createInvite,
  getInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
  type KeyringDependency,
} from "./invites";

/**
 * An in-memory stand-in for the OS keyring, so this suite proves the real happy path — a
 * token minted, stored, and later readable under the redeemer's name — without writing a
 * single entry into whoever runs `bun test`'s actual macOS Keychain or libsecret. See
 * `KeyringDependency`'s own comment in `invites.ts` for why this seam exists at all.
 */
function fakeKeyring(backend: KeyringBackend = "macos") {
  const store = new Map<string, string>();
  const dependency: KeyringDependency = {
    detectBackend: () => Effect.succeed(backend),
    storeToken: (_backend, account, token) =>
      Effect.sync(() => {
        store.set(account, token);
        return true;
      }),
  };
  return { dependency, get: (account: string) => store.get(account) };
}

let jazzHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-peer-invites-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await nodeFs.rm(jazzHome, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const CREATE_INPUT = {
  inviteeName: "bob",
  inviterDisplayName: "alice",
  inviterAskUrl: "http://127.0.0.1:4747/peer/ask",
  proposedTier: "internal",
  ttlMs: 60_000,
} as const;

describe("createInvite", () => {
  it("mints a fresh, unguessable id and never persists the secret in plaintext", async () => {
    const first = await run(createInvite(CREATE_INPUT));
    const second = await run(createInvite(CREATE_INPUT));

    expect(first.record.id).not.toEqual(second.record.id);
    expect(first.record.id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.secret).not.toEqual(second.secret);

    const raw = await nodeFs.readFile(
      path.join(jazzHome, "peers", "invites", `${first.record.id}.json`),
      "utf-8",
    );
    expect(raw).not.toContain(first.secret);
  });

  it("round-trips through getInvite", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    const fetched = await run(getInvite(created.record.id));
    expect(fetched).toEqual(created.record);
  });
});

describe("redeemInvite", () => {
  it("succeeds exactly once for a correct secret", async () => {
    const created = await run(createInvite(CREATE_INPUT));

    const first = await run(redeemInvite({ id: created.record.id, secret: created.secret }, "bob"));
    expect(first.kind).toEqual("ok");

    const second = await run(
      redeemInvite({ id: created.record.id, secret: created.secret }, "bob"),
    );
    expect(second.kind).toEqual("already-redeemed");
  });

  it("rejects a wrong secret without consuming the invite", async () => {
    const created = await run(createInvite(CREATE_INPUT));

    const wrong = await run(redeemInvite({ id: created.record.id, secret: "not-it" }, "bob"));
    expect(wrong.kind).toEqual("bad-secret");

    const correct = await run(
      redeemInvite({ id: created.record.id, secret: created.secret }, "bob"),
    );
    expect(correct.kind).toEqual("ok");
  });

  it("rejects an unknown id", async () => {
    const outcome = await run(redeemInvite({ id: "0".repeat(32), secret: "x" }, "bob"));
    expect(outcome.kind).toEqual("not-found");
  });

  it("rejects a revoked invite", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    expect(await run(revokeInvite(created.record.id))).toBe(true);

    const outcome = await run(
      redeemInvite({ id: created.record.id, secret: created.secret }, "bob"),
    );
    expect(outcome.kind).toEqual("revoked");
  });

  it("rejects an expired invite, distinctly from a bad secret", async () => {
    const created = await run(createInvite({ ...CREATE_INPUT, ttlMs: -1 }));

    const outcome = await run(
      redeemInvite({ id: created.record.id, secret: created.secret }, "bob"),
    );
    expect(outcome.kind).toEqual("expired");
  });

  it("does not let two concurrent redemptions both succeed", async () => {
    const created = await run(createInvite(CREATE_INPUT));

    const [first, second] = await Promise.all([
      run(redeemInvite({ id: created.record.id, secret: created.secret }, "bob")),
      run(redeemInvite({ id: created.record.id, secret: created.secret }, "bob")),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(["already-redeemed", "ok"]);
  });
});

describe("revokeInvite", () => {
  it("is false for an invite that was already redeemed", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    await run(redeemInvite({ id: created.record.id, secret: created.secret }, "bob"));
    expect(await run(revokeInvite(created.record.id))).toBe(false);
  });

  it("is false for an unknown id", async () => {
    expect(await run(revokeInvite("0".repeat(32)))).toBe(false);
  });
});

describe("listInvites", () => {
  it("returns everything created on this machine, newest first", async () => {
    const older = await run(createInvite(CREATE_INPUT));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await run(createInvite({ ...CREATE_INPUT, inviteeName: "carol" }));

    const listed = await run(listInvites());
    expect(listed.map((invite) => invite.id)).toEqual([newer.record.id, older.record.id]);
  });
});

/** A minimal fake config service, upsert-testable the same way `peer-tools.test.ts` fakes one. */
function fakeConfigLayer(initialPeers: readonly PeerConfig[] = []) {
  let peers = initialPeers;
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
    appConfig: Effect.sync((): AppConfig => ({ ...({} as AppConfig), peers })),
  };
  return { layer: Layer.succeed(AgentConfigServiceTag, service), currentPeers: () => peers };
}

describe("acceptInviteOnInviterSide", () => {
  it("grants the tier, mints and stores a token, and hands it back with the ask URL", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    const { layer, currentPeers } = fakeConfigLayer();
    const keyring = fakeKeyring();

    const outcome = await Effect.runPromise(
      acceptInviteOnInviterSide(
        { id: created.record.id, secret: created.secret, redeemedAs: "bob" },
        keyring.dependency,
      ).pipe(Effect.provide(layer)),
    );

    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    expect(outcome.inviterAskUrl).toEqual(CREATE_INPUT.inviterAskUrl);
    expect(outcome.token).toMatch(/^[0-9a-f]{48}$/);

    expect(currentPeers()).toEqual([{ name: "bob", disclosure: "internal" }]);
    expect(keyring.get(peerTokenPath("bob"))).toEqual(outcome.token);
  });

  it("files the redeemer under the name *the inviter* chose at creation time, not whatever the redeemer happened to call the inviter", async () => {
    // A real run of this exposed the bug this guards: alice's own choice of what to call bob
    // (sent along in the accept request purely for the audit trail) was being used as the key
    // for *bob's* upsert too — so bob ended up filing alice under alice's nickname for him,
    // rather than "alice", the name bob picked when he created the invite.
    const created = await run(createInvite({ ...CREATE_INPUT, inviteeName: "alice" }));
    const { layer, currentPeers } = fakeConfigLayer();

    const outcome = await Effect.runPromise(
      acceptInviteOnInviterSide(
        { id: created.record.id, secret: created.secret, redeemedAs: "some-other-name" },
        fakeKeyring().dependency,
      ).pipe(Effect.provide(layer)),
    );

    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    expect(currentPeers()).toEqual([{ name: "alice", disclosure: "internal" }]);
  });

  it("merges into an existing peer entry rather than clobbering it — the two-one-way-invites-make-a-mutual-relationship case", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    // Bob already has a "sam"-shaped entry from asking bob previously — i.e. redeemedAs=bob
    // already has a `url` on the inviter's side, from a prior invite in the other direction.
    const { layer, currentPeers } = fakeConfigLayer([{ name: "bob", url: "http://bob/peer/ask" }]);

    await Effect.runPromise(
      acceptInviteOnInviterSide(
        { id: created.record.id, secret: created.secret, redeemedAs: "bob" },
        fakeKeyring().dependency,
      ).pipe(Effect.provide(layer)),
    );

    expect(currentPeers()).toEqual([
      { name: "bob", url: "http://bob/peer/ask", disclosure: "internal" },
    ]);
  });

  it("refuses to consume the invite when no keyring is available, so the link stays redeemable once one is", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    const { layer } = fakeConfigLayer();

    const outcome = await Effect.runPromise(
      acceptInviteOnInviterSide(
        { id: created.record.id, secret: created.secret, redeemedAs: "bob" },
        fakeKeyring("none").dependency,
      ).pipe(Effect.provide(layer)),
    );
    expect(outcome.kind).toEqual("no-keyring");

    const fetched = await run(getInvite(created.record.id));
    expect(fetched?.redeemedAt).toBeUndefined();
  });

  it("refuses to consume the invite when the keyring rejects its write", async () => {
    const created = await run(createInvite(CREATE_INPUT));
    const { layer, currentPeers } = fakeConfigLayer();
    const failingKeyring: KeyringDependency = {
      detectBackend: () => Effect.succeed("macos"),
      storeToken: () => Effect.succeed(false),
    };

    const outcome = await Effect.runPromise(
      acceptInviteOnInviterSide(
        { id: created.record.id, secret: created.secret, redeemedAs: "bob" },
        failingKeyring,
      ).pipe(Effect.provide(layer)),
    );

    expect(outcome.kind).toEqual("no-keyring");
    expect(currentPeers()).toEqual([]);
    expect((await run(getInvite(created.record.id)))?.redeemedAt).toBeUndefined();
  });
});
