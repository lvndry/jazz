---
description: "Implementation plan for peer invites: how Jazz should add invite URLs, accept flows, and automatic peer bootstrap without changing the core peer trust model."
---

# Peer invites — implementation plan

This is the implementation plan for the peer-invite bootstrap flow described in
[Setting up peers](../start/peers-setup.md).

The goal is to make peer setup feel like an invitation instead of a manual
key exchange, while keeping the current trust model intact.

---

## Scope

### In scope

- invite creation
- invite acceptance
- invite expiration and single-use redemption
- automatic peer/config bootstrap after acceptance
- token storage in the OS keyring
- explicit tier confirmation
- a shareable invite URL
- optional QR output in the CLI

### Out of scope

- automatic peer discovery
- public directory listing of peers
- gRPC/protobuf transport migration
- peer actions
- approval prompts for peers
- changing the meaning of tiers

---

## Design constraints

1. **No trust by discovery.**
   The invite may locate a peer, but it may not create trust by itself.

2. **No long-lived secret in the link.**
   The invite URL should carry only a short-lived redeem secret and an invite id, not the final peer token.

3. **Keep the current endpoint model.**
   The existing `POST /peer/ask` path should remain the runtime communication path.

4. **Make setup explicit.**
   Humans should still see the endpoint, tier, and expiration before confirming.

5. **Keep the current peer policy.**
   A redeemed invite should still end in the same explicit peer config, same tiers, same read-only toolset.

---

## Proposed user story

### One-way bootstrap

1. Alice wants Bob to be able to talk to her agent.
2. Alice creates an invite that points at her peer endpoint and proposes a tier.
3. Alice sends Bob the invite URL.
4. Bob accepts the invite.
5. Bob's Jazz writes the peer entry and shared secret locally.
6. Alice's Jazz marks the invite redeemed.

### Mutual bootstrap

If both sides want two-way communication, each side can create and accept an invite.

That keeps the mental model simple:

- one invite = one relationship direction
- two invites = two-way communication

The implementation can still support a convenience mode later if we decide that one invite should bootstrap both sides.

---

## Data model

### Invite record (`PeerInviteRecord`, `packages/core/src/types/peer-invite.ts`)

- `id` — 128 bits from `randomBytes(16)`, hex-encoded. Doubles as the filename
  (`<peers-dir>/invites/<id>.json`), matching `FileRunStore`'s one-file-per-record pattern.
- `inviteeName` — the name the inviter will file the redeemer under, once accepted (their own
  bookkeeping; the positional argument to `invite create`).
- `inviterDisplayName` — what the inviter wants to be called by whoever redeems this. Not
  originally in the design sketch — added because the redeemer's accept confirmation ("this
  invite is from ...") had nothing else to show. Defaults to the inviter's hostname.
- `inviterAskUrl` — the inviter's own `/peer/ask` URL, handed to the redeemer.
- `proposedTier`, `createdAt`, `expiresAt`, `secretHash` (sha256 of the secret — never the
  secret itself), `redeemedAt?`, `redeemedAs?` (audit only), `revokedAt?`.

### Peer record

The accepted invite produces the normal `PeerConfig` entry plus keyring token storage — no new
permanent relationship type.

One correction to the original sketch: `PeerConfig.url` had to become optional. A `PeerConfig`
already conflates two independent capabilities (`url`: I can ask them; `disclosure`: they can ask me),
and a one-way invite naturally produces an entry with only one of those set. Making `url`
required would have forced a `""`-shaped placeholder on the granting side of every invite.
Fixing this surfaced a real, pre-existing bug: `ask_peer`'s "is this peer askable" filter was
checking `disclosure` instead of `url` — meaning a peer with `url` but no `disclosure` (exactly what a
one-way invite produces on the *asking* side, and what `docs/start/peers-setup.md`'s own
manual walkthrough describes) was silently un-askable. Fixed alongside this feature since the
feature would otherwise ship broken by inheriting it.

Acceptance **upserts** rather than replaces: if a peer entry with that name already exists
(from an earlier invite run in the other direction), the write merges in only the field the
new invite grants, leaving the other side's field untouched. This is what makes "run the flow
twice" a correct way to get mutual communication.

---

## API / CLI shape

```bash
jazz peers invite create <invitee-name> --disclosure <tier> [--expires 24h] [--host 127.0.0.1] [--port 4747] [--as <your-display-name>] [--qr] [--json]
jazz peers invite accept <invite-url> [--as <local-name>] [--yes] [--json]
jazz peers invite list [--json]
jazz peers invite revoke <invite-id>
```

There is no `--endpoint` flag. `create` cannot introspect a running daemon's bind address (it
is a separate, short-lived CLI process, not code running inside the daemon), so it takes the
same `--host`/`--port` the eventual `jazz daemon` call will use, defaulting identically
(`127.0.0.1:4747`) — the common single-agent case needs neither flag.

`--host`/`--home` (a new global CLI flag, `jazz --home <dir>`, equivalent to exporting
`JAZZ_HOME` first) make the two-agents-on-one-host case usable without env-var juggling.

---

## HTTP endpoint shape

Only two of the four originally-sketched routes are actually network operations. `create`,
`list`, and `revoke` never touch the network — the inviter already has a shell on the machine
whose invite store and config they're changing, so those are plain CLI commands reading and
writing local files directly (`@jazz/adapters/peers/invites`), the same way `jazz peers log`
reads the ledger without going through the daemon. Only a *redeemer*, who by construction is
not on this machine, ever needs HTTP:

- `GET /peer-invites/:id` — unauthenticated metadata preview (inviter name, ask URL, proposed
  tier, expiry, status). Enough to render a confirmation, not enough to be useful without the
  secret.
- `POST /peer-invites/:id/accept` — redeem. Body is `{ secret, as }`; response is
  `{ ok, inviterAskUrl, token }` on success, or a specific error (`404`/`410`/`401`/`500`) per
  failure kind (not found / expired / already redeemed / revoked / bad secret / no keyring).

Both live in `makePeerInviteHandler` (`packages/adapters/src/daemon/server.ts`), a fourth
"door" alongside the operator's, a peer's, and a trigger's — its own auth model (the redeem
secret, not a standing bearer token).

The fragment secret in the URL is never sent on the `GET`; only the `POST .../accept` body
carries it, over whatever transport the endpoint uses (see the security-model note on
plaintext HTTP below).

### The bug this surfaced: `makePeerHandler` read the peer list once, at daemon startup

`jazz daemon` originally captured `appConfig.peers` once, before entering its request loop,
and closed over that array. An invite accepted five minutes into the process's life would
never be recognized by `/peer/ask` until the daemon restarted — silently defeating the entire
point of accepting a peer over HTTP instead of editing config by hand. Fixed by changing
`makePeerHandler` to take a `resolvePeers: () => Promise<readonly PeerConfig[]>` thunk instead
of a static array; `daemon.ts` now re-reads `AgentConfigService.appConfig` on every `/peer/ask`
request. Proven by `packages/adapters/src/daemon/peer-invite-flow.test.ts`: the same handler
closure, built before an invite exists, authorizes the token that invite mints.

---

## Acceptance flow

### Step 1: render the invite

When a user accepts an invite, Jazz should show:

- inviter name
- inviter endpoint
- proposed tier
- expiry
- whether the invite is one-way or mutual

### Step 2: explicit confirmation

The user confirms that they want to create the peer relationship.

### Step 3: verify and redeem

The accepting side sends the invite id and secret to the inviter side.

The inviter side verifies:

- invite exists
- secret matches
- invite is not expired
- invite has not already been redeemed
- the proposed tier is valid

### Step 4: write the relationship

After verification, both sides store what they need:

- peer config entry
- token in the OS keyring
- invite marked redeemed

### Step 5: clean up

The invite should be treated as spent and no longer reusable.

---

## Security checks

All covered in `packages/adapters/src/peers/invites.test.ts` and
`packages/adapters/src/daemon/peer-invite-flow.test.ts`:

- expired invite cannot be redeemed (distinctly from a bad secret)
- redeemed invite cannot be reused, including under concurrent redemption attempts
- invite secret mismatch is rejected without consuming the invite
- revoked invite is rejected
- redemption is refused, without consuming the invite, when no keyring is available to store
  the resulting token
- acceptance shows the endpoint and tier before any write happens (the CLI's confirmation
  prompt, gated by `TerminalService.confirm`)
- the invite record never persists the redeem secret in plaintext (only its hash)
- invite ids are checked against a fixed shape before ever reaching a path join (`isInviteId`)

---

## Files changed

### Core types and contracts

- `packages/core/src/types/peer.ts` — `PeerConfig.url` made optional
- `packages/core/src/types/peer-invite.ts` — new: `PeerInviteRecord`, `inviteStatus`, `isInviteId`
- `packages/core/src/interfaces/peer-invites.ts` — new: `PeerInviteService`
- `packages/core/src/agent/tools/peer-tools.ts` — `ask_peer`'s askability filter fixed to check
  `url`, not `disclosure` (see the data-model section above)

### Peer adapters and storage

- `packages/adapters/src/peers/invites.ts` — new: the file-backed invite store, redemption
  state machine, `acceptInviteOnInviterSide`
- `packages/adapters/src/peers/config.ts` — new: `upsertPeer`, the merge-by-name write both
  sides of acceptance use
- `packages/adapters/src/daemon/server.ts` — `makePeerHandler` takes a live `resolvePeers`
  thunk instead of a static array; `makePeerInviteHandler` added

### CLI

- `packages/cli/src/commands/peer-invites.ts` — new: `create`/`accept`/`list`/`revoke`
- `packages/cli/src/utils/option-parsers.ts` — `parseDurationMs` for `--expires`
- `packages/runtime/src/cli-app.ts` — `peers invite ...` subcommands; new global `--home` flag
- `qrcode-terminal` — new dependency, for `--qr`

### Docs

- `docs/start/peers-setup.md`, `docs/internals/peer-invites.md` (this file) — corrected
  against the implementation
- `docs/start/peers-setup.md` — invite-based path added alongside the manual one
- `docs/concepts/index.md`, `docs/internals/index.md` — linked

### Tests

- `packages/core/src/types/peer-invite.test.ts`
- `packages/adapters/src/peers/invites.test.ts`
- `packages/adapters/src/daemon/peer-invite-flow.test.ts` — the full HTTP round trip through
  real handler factories, stopping at the authorization boundary (no real LLM)
- `packages/core/src/agent/tools/peer-tools.test.ts` — updated for the askability-filter fix
- `scripts/peers/two-agents-localhost.sh` — the same scenario with a real agent stack, run by hand
- `scripts/peers/cross-network/` — the same scenario across two Docker networks with no route
  between them, bridged only by a reverse proxy, exercising `--public-url` for real

---

## Testing plan (as implemented)

### Unit tests (`invites.test.ts`, `peer-invite.test.ts`)

- invite creation mints a fresh, unguessable id and never persists the secret in plaintext
- redemption succeeds exactly once; a wrong secret does not consume it; concurrent redemption
  attempts for the same invite never both succeed
- expired / revoked / already-redeemed / not-found are distinct, correctly-ordered outcomes
- `acceptInviteOnInviterSide` grants the tier, mints and stores a token, merges into an
  existing peer entry rather than clobbering it, and refuses to consume the invite when no
  keyring is available — all against an injected in-memory keyring (`KeyringDependency`),
  never the real OS keychain, matching `keyring.test.ts`'s own reasoning for avoiding that

### Integration tests (`peer-invite-flow.test.ts`)

- the full HTTP round trip (preview → accept → authorized `/peer/ask`) through the real daemon
  handler factories, with a real invite store and a fake keyring/agent stack
- proves the live-reload fix: the same `handlePeer` closure built before the invite existed
  authorizes the token that invite minted
- a wrong token still fails after a real one exists; a second accept on the same invite fails

### Manual / real-agent verification

- `scripts/peers/two-agents-localhost.sh` — the same scenario with two real agents and a real LLM,
  since a model's actual answer is not something a deterministic CI run should depend on

---

## Delivery status

All four phases shipped in one pass: model/storage, CLI/keyring, daemon endpoints, and docs —
see [Files changed](#files-changed) above.

---

## Recommendation (as followed)

The invite flow was implemented **before** touching transport, per the original
recommendation below. It also fixed one bug it inherited from the existing peer model
(`ask_peer`'s askability filter) and one architectural gap it would otherwise have shipped
broken by (the daemon's one-time peer-list snapshot).

The biggest win is not protobuf or gRPC. It is turning peer setup from:

- manual URL
- manual secret
- manual config edit

into:

- create invite
- send link
- accept
- done
