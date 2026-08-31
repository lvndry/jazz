/**
 * @fileoverview A bootstrap credential that answers one HTTP round-trip and then stops existing.
 *
 * One JSON file per invite, matching `FileRunStore`'s reasoning exactly: records are small
 * and self-contained, so there is no index to keep in step and no append log to compact. The
 * id doubles as the filename, so a listing is a directory read.
 *
 * The one property a run record never needed but an invite does: **redemption must be
 * atomic**. Two requests racing to redeem the same invite must not both observe it as valid —
 * a single-use credential that is not actually enforceable as single-use is not single-use.
 * Bun/Node are single-threaded for JS execution, but the read-check-write sequence below spans
 * `await` points, so two nearly-simultaneous HTTP requests for the same invite id can still
 * interleave between them. `withRedeemLock` below serializes redemption per invite id within
 * this process — sufficient because exactly one process (the inviter's daemon) ever redeems a
 * given invite.
 */

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type {
  CreateInviteInput,
  CreatedInvite,
  PeerInviteService,
  RedeemInviteInput,
} from "@jazz/core/interfaces/peer-invites";
import { PeerInviteServiceTag } from "@jazz/core/interfaces/peer-invites";
import {
  inviteStatus,
  isInviteId,
  type PeerInviteRecord,
  type RedeemInviteOutcome,
} from "@jazz/core/types/peer-invite";
import { Effect, Layer } from "effect";
import { upsertPeer } from "@/adapters/peers/config";
import { getPeersDirectory } from "@/adapters/peers/ledger";
import { detectKeyringBackend, keyringSet, type KeyringBackend } from "@/adapters/secrets/keyring";
import { peerTokenPath } from "@/adapters/secrets/registry";

const INVITES_SUBDIRECTORY = "invites";

export function getInvitesDirectory(): string {
  return path.join(getPeersDirectory(), INVITES_SUBDIRECTORY);
}

function pathFor(id: string): string {
  if (!isInviteId(id)) {
    throw new Error(`"${id}" is not a usable invite id.`);
  }
  return path.join(getInvitesDirectory(), `${id}.json`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

/**
 * Mirrors the daemon's own bearer-token comparison (`tokenMatches` in
 * `@jazz/adapters/daemon/server`): does not return on the first differing byte, so a redeem
 * secret cannot be guessed one character at a time over a slow link. Kept local rather than
 * imported — `adapters/peers` sits below `adapters/daemon` in the dependency direction, and
 * this is four lines, not worth inverting that for.
 */
function hashesMatch(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

function readRecord(raw: string): PeerInviteRecord | undefined {
  try {
    return JSON.parse(raw) as PeerInviteRecord;
  } catch {
    return undefined;
  }
}

async function readInviteFile(id: string): Promise<PeerInviteRecord | undefined> {
  try {
    return readRecord(await nodeFs.readFile(pathFor(id), "utf-8"));
  } catch {
    return undefined;
  }
}

async function writeInviteFile(record: PeerInviteRecord): Promise<void> {
  await nodeFs.mkdir(getInvitesDirectory(), { recursive: true });
  const destination = pathFor(record.id);
  // Same truncated-write guard as `FileRunStore`: a reader mid-write must see either the
  // old record or the new one, never a half-written file it silently treats as absent.
  const temporary = `${destination}.${process.pid}.tmp`;
  await nodeFs.writeFile(temporary, JSON.stringify(record, null, 2), "utf-8");
  await nodeFs.rename(temporary, destination);
}

function persistenceError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Invite state is authorization state: unlike the peer ledger, a failed write must fail closed. */
function writeInvite(record: PeerInviteRecord): Effect.Effect<void, Error> {
  return Effect.tryPromise({ try: () => writeInviteFile(record), catch: persistenceError });
}

export function getInvite(id: string): Effect.Effect<PeerInviteRecord | undefined, never> {
  if (!isInviteId(id)) return Effect.succeed(undefined);
  return Effect.promise(() => readInviteFile(id));
}

export function listInvites(): Effect.Effect<readonly PeerInviteRecord[], never> {
  return Effect.tryPromise({
    try: async () => {
      const entries = await nodeFs.readdir(getInvitesDirectory());
      const records: PeerInviteRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.includes(".tmp")) continue;
        const raw = await nodeFs.readFile(path.join(getInvitesDirectory(), entry), "utf-8");
        const parsed = readRecord(raw);
        if (parsed !== undefined) records.push(parsed);
      }
      return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly PeerInviteRecord[])));
}

export function createInvite(input: CreateInviteInput): Effect.Effect<CreatedInvite, Error> {
  return Effect.sync(() => {
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(24).toString("hex");
    const now = new Date();
    const record: PeerInviteRecord = {
      id,
      inviteeName: input.inviteeName,
      inviterDisplayName: input.inviterDisplayName,
      inviterAskUrl: input.inviterAskUrl,
      proposedTier: input.proposedTier,
      ...(input.proposedPersona !== undefined ? { proposedPersona: input.proposedPersona } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      secretHash: sha256Hex(secret),
    };
    return { record, secret };
  }).pipe(Effect.tap(({ record }) => writeInvite(record)));
}

export function revokeInvite(id: string): Effect.Effect<boolean, Error> {
  if (!isInviteId(id)) return Effect.succeed(false);
  return Effect.tryPromise({
    try: () =>
      withRedeemLock(id, async () => {
        const existing = await readInviteFile(id);
        if (
          existing === undefined ||
          existing.revokedAt !== undefined ||
          existing.redeemedAt !== undefined
        ) {
          return false;
        }
        await writeInviteFile({ ...existing, revokedAt: new Date().toISOString() });
        return true;
      }),
    catch: persistenceError,
  });
}

/**
 * Serializes redemption per invite id within this process.
 *
 * A `Map` of chained promises rather than a real mutex library: the daemon is one process, one
 * event loop, and this only needs to order two `async` functions that both touch the same
 * file — not coordinate across processes or survive a restart.
 */
const redeemLocks = new Map<string, Promise<unknown>>();

function withRedeemLock<A>(id: string, run: () => Promise<A>): Promise<A> {
  const previous = redeemLocks.get(id) ?? Promise.resolve();
  const next = previous.then(run, run);
  redeemLocks.set(
    id,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function redeemInvite(
  input: RedeemInviteInput,
  redeemedAs: string,
): Effect.Effect<RedeemInviteOutcome, Error> {
  if (!isInviteId(input.id)) {
    return Effect.succeed({ kind: "not-found" });
  }
  return Effect.tryPromise({
    try: () =>
      withRedeemLock(input.id, async () => {
        const record = await readInviteFile(input.id);
        if (record === undefined) return { kind: "not-found" } satisfies RedeemInviteOutcome;

        const status = inviteStatus(record, new Date());
        if (status === "revoked") return { kind: "revoked" } satisfies RedeemInviteOutcome;
        if (status === "redeemed") {
          return { kind: "already-redeemed" } satisfies RedeemInviteOutcome;
        }
        if (status === "expired") {
          return { kind: "expired", expiresAt: record.expiresAt } satisfies RedeemInviteOutcome;
        }

        if (!hashesMatch(record.secretHash, sha256Hex(input.secret))) {
          return { kind: "bad-secret" } satisfies RedeemInviteOutcome;
        }

        const redeemed: PeerInviteRecord = {
          ...record,
          redeemedAt: new Date().toISOString(),
          redeemedAs,
        };
        await writeInviteFile(redeemed);
        return { kind: "ok", record: redeemed } satisfies RedeemInviteOutcome;
      }),
    catch: persistenceError,
  });
}

export function createPeerInviteServiceLayer(): Layer.Layer<PeerInviteService> {
  return Layer.succeed(PeerInviteServiceTag, {
    create: createInvite,
    get: getInvite,
    list: listInvites,
    revoke: revokeInvite,
    redeem: redeemInvite,
  });
}

export type AcceptInviteOutcome =
  | { readonly kind: "ok"; readonly inviterAskUrl: string; readonly token: string }
  /** The invite is otherwise valid, but there is nowhere safe to store the token it would
   * generate. Checked *before* consuming the invite, so a machine with no keyring does not
   * burn a single-use link on a redemption it cannot actually complete. */
  | { readonly kind: "no-keyring" }
  | Exclude<RedeemInviteOutcome, { kind: "ok" }>;

/**
 * The two keyring calls `acceptInviteOnInviterSide` needs, as an injectable seam.
 *
 * Every other keyring-touching command in the product (`jazz peers set-token`, `jazz daemon
 * set-token`) calls `detectKeyringBackend`/`keyringSet` directly and, for exactly that reason,
 * has never had its actual-storage happy path exercised by an automated test — doing so would
 * write real entries into whoever is running the suite's OS keychain, which `keyring.test.ts`
 * deliberately avoids. This function is the one keyring-writing code path a test needs to
 * exercise *completely*, because it also proves the daemon's live-reload authorization
 * boundary end to end — so it takes its keyring calls as parameters instead, defaulting to the
 * real ones. Production callers never pass this; only tests substitute an in-memory fake.
 */
export interface KeyringDependency {
  readonly detectBackend: () => Effect.Effect<KeyringBackend, never>;
  readonly storeToken: (
    backend: KeyringBackend,
    account: string,
    token: string,
  ) => Effect.Effect<boolean, never>;
}

const REAL_KEYRING: KeyringDependency = {
  detectBackend: detectKeyringBackend,
  storeToken: keyringSet,
};

/**
 * The inviter side of redemption, composed from three narrower effects: verify-and-consume
 * the invite (`redeemInvite`), grant the tier (`upsertPeer`), and hand the redeemer a token
 * they did not have to be told out of band (the injected `storeToken`, `keyringSet` in
 * production).
 *
 * This is the one place a peer token is *generated* rather than typed by a human — the entire
 * reason `jazz peers set-token` and `openssl rand -hex 24` exist today is that nothing else in
 * the product could safely invent a secret shared between two machines it doesn't control.
 * Here it can: the secret only ever needs to reach the caller of *this* authenticated
 * request, which the redeem-secret check above already established is the invite's holder.
 */
export function acceptInviteOnInviterSide(
  input: RedeemInviteInput & { readonly redeemedAs: string },
  keyring: KeyringDependency = REAL_KEYRING,
): Effect.Effect<AcceptInviteOutcome, Error, AgentConfigService> {
  return Effect.gen(function* () {
    const backend = yield* keyring.detectBackend();
    if (backend === "none") return { kind: "no-keyring" } as const;

    // Do a non-consuming check before touching the standing credential. The locked redemption
    // below remains authoritative; this only prevents a bad secret from overwriting a token.
    const candidate = yield* getInvite(input.id);
    if (
      candidate === undefined ||
      inviteStatus(candidate, new Date()) !== "active" ||
      !hashesMatch(candidate.secretHash, sha256Hex(input.secret))
    ) {
      const outcome = yield* redeemInvite(input, input.redeemedAs);
      // The pre-check can only reject a record that cannot become active again. Keep the
      // public outcome narrow even if an external state change somehow violates that rule.
      return outcome.kind === "ok" ? ({ kind: "already-redeemed" } as const) : outcome;
    }

    // Store before consuming the invite. If persisting `redeemedAt` fails, no peer entry is
    // granted and a retry simply replaces this unused token with a freshly minted one.
    const token = randomBytes(24).toString("hex");
    const stored = yield* keyring.storeToken(backend, peerTokenPath(candidate.inviteeName), token);
    if (!stored) return { kind: "no-keyring" } as const;

    // `outcome.record.inviteeName` — the name *this* side (the inviter) chose at creation
    // time — is the key for this side's own upsert and token storage. `input.redeemedAs` is
    // what the *redeemer* chose to call the inviter, sent along purely for the audit record;
    // using it here would file the redeemer under whatever name they happened to pick for
    // someone else, rather than the name the inviter actually chose for them.
    yield* upsertPeer({
      name: candidate.inviteeName,
      may: candidate.proposedTier,
      ...(candidate.proposedPersona !== undefined ? { persona: candidate.proposedPersona } : {}),
    });

    const outcome = yield* redeemInvite(input, input.redeemedAs);
    if (outcome.kind !== "ok") return outcome;

    return { kind: "ok", inviterAskUrl: outcome.record.inviterAskUrl, token };
  });
}
