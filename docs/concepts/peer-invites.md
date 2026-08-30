---
description: "A secure invite/accept bootstrap for Jazz peers: short-lived invitation URLs, explicit acceptance, and no change to the existing token/tier model."
---

# Peer invites

Peer invites are a bootstrap layer for the existing Jazz peer model.

They solve the awkward part of setup — "how do two people who already want to talk actually exchange enough information to become peers?" — without changing the core trust model:

- peers are still explicit
- peer traffic is still read-only
- tiers still bound disclosure
- answers are still quoted as untrusted text
- peer runs still stay in their own conversation

The invite is not a new trust model. It is a better way to get to the existing one.

---

## Why this exists

Today, peer setup is technically simple but socially awkward:

- both sides must know an endpoint
- both sides must store a shared token
- both sides must edit config manually
- the token setup is hidden behind environment variables and the OS keyring

That is secure enough, but not friendly enough. Peer invites aim to make the first contact flow feel more like a normal invitation:

- I invite you
- you accept
- Jazz writes the peer entries and shared secret for us

---

## Design goals

1. **Keep the current security model.**
   - explicit enrollment
   - per-peer tokens
   - tiered disclosure
   - no peer actions
   - no peer approval prompts

2. **Make first contact easy.**
   - generate a shareable invite link
   - let the other side accept it with one command
   - avoid manual env-var gymnastics

3. **Work for the real network cases Jazz already supports.**
   - same machine / loopback
   - same LAN or tailnet
   - internet behind TLS / reverse proxy

4. **Avoid false trust.**
   - an invite is a bootstrap credential, not a permanent relationship
   - acceptance must be explicit
   - invites expire and are single-use

---

## Non-goals

- No automatic peer discovery.
- No automatic trust based on seeing an endpoint.
- No replacement of the current peer tiers.
- No peer actions.
- No change to the existing `ask_peer` execution model.
- No transport swap to gRPC/protobuf just to solve onboarding.

---

## Shape

### The invite

An invite is a short-lived, single-use object created by the side that wants to be reachable.
It contains:

- the name Alice (the inviter) is choosing to file the invitee under, once accepted
- what Alice wants to be called by the invitee (defaults to her hostname)
- Alice's own `/peer/ask` endpoint
- the proposed tier
- an expiration time
- a one-time invite id
- a one-time redeem secret

The invite is shareable as a URL, or as a QR code printed alongside it in the terminal
(`--qr`).

The link is a plain HTTP(S) URL, not a custom `jazz://` scheme:

```text
http://100.101.102.103:4747/peer-invites/<invite-id>#<redeem-secret>
```

It is self-describing on purpose — the host and port it points at *are* the daemon's own bind
address, so redeeming it never needs a separately-typed `--endpoint`. A custom `jazz://` scheme
would still need to encode exactly the same host, port, id, and secret; it would be a second
parser for the same data; not worth the surface for what it buys.

The fragment matters because it keeps the secret out of logs and proxies by default: a `GET`
never sends it to the server.

### The accept step

The recipient runs an explicit accept command:

```bash
jazz peers invite accept <invite-url>
```

Acceptance shows the human:

- who invited them, and at what endpoint
- which tier is proposed
- when the invite expires

Then it requires confirmation — the same `terminal.confirm()` primitive `jazz agent delete`
already uses, so a non-interactive session (a script, CI) is refused rather than silently
accepting, unless it passes `--yes`.

### What gets written after accept

Both sides write something, and they write *different* things — this is the one place the
concept doc originally undersold what a one-way invite needs:

- **The redeemer** (Bob) writes `{ name: <chosen local name>, url: <Alice's endpoint> }` into
  his own config, and stores the shared token under that name in his keyring. This is what
  lets *him* ask *her*.
- **The inviter's daemon** (Alice's, mid-request, the moment it verifies the redeem secret)
  writes `{ name: <the name Alice chose for Bob>, may: <the proposed tier> }` into her own
  config, and stores the same token under that name in her keyring. This is what lets *her*
  daemon recognize and authorize *his* future questions — without it, her `/peer/ask` would
  401 him forever, invite or no invite.

If a peer entry with that name already exists on either side (say, from an earlier invite run
in the other direction), the write **merges** rather than replaces: a `url` from one invite and
a `may` from another compose into one fully mutual relationship, instead of the second invite
clobbering the first.

This machine's daemon does not need restarting for any of this to take effect — the peer list
it authorizes against is read fresh on every `/peer/ask` request, not captured once at startup.

Mutual communication is just running this flow twice, once in each direction. There is no
separate "mutual" mode: a second one-way invite for the same name merges into the first.

---

## Security model

Peer invites are intentionally weaker than a long-term peer relationship.

That is okay, because they are only meant to bootstrap the relationship.

### What an invite may do

- identify the intended peer
- propose an endpoint
- propose a disclosure tier
- authorize the first enrollment step

### What an invite must not do

- grant permanent access
- bypass tier confirmation
- expose the long-term shared token in plaintext
- allow anonymous reuse
- replace explicit config

### Required properties

- **Single-use:** once redeemed, the invite is dead. Enforced server-side, atomically, so two
  requests racing to redeem the same invite cannot both succeed.
- **Expiring:** stale links stop working, checked at redemption time, not just displayed.
- **Explicit:** a human still confirms the peer being added.
- **Bounded:** the invite cannot create capabilities beyond the current peer model.
- **Unguessable:** the invite id is 128 bits of randomness, not sequential — the preview
  endpoint (`GET /peer-invites/:id`) is unauthenticated, so enumeration resistance has to live
  in the id itself, not in a credential check.

### A wire transfer this feature adds that manual setup never had

Today, a human pastes the shared token by hand, out of band — Signal, in person, whatever
channel they already trust. Accepting an invite instead has the *inviter's own daemon*
generate that token and send it back over the same HTTP connection the redeem request arrived
on. On loopback or a private/Tailscale network that's exactly as safe as the existing "no
encryption needed" cases in `docs/guide/peers-setup.md`. On a public, plain-`http://` endpoint
it is a new plaintext exposure this feature introduces — both `invite create` and `invite
accept` print an explicit warning when the endpoint isn't loopback or a recognized private
network, rather than silently inheriting the risk.

---

## Invitation flow

A concrete flow for "Bob is on my LAN and I want him to be able to ask my agent something":

1. Bob is already serving: `jazz daemon --serve-peers bob --port 4748`.
2. Bob runs `jazz peers invite create alice --port 4748 --may about-me --expires 1h`. This is
   a local operation — it writes an invite record next to Bob's peer state and prints a link;
   Bob's own daemon doesn't need to already be running for this step, only by the time Alice
   redeems it.
3. Bob sends the link to Alice out of band.
4. Alice runs `jazz peers invite accept <link>`, which fetches a preview from Bob's daemon
   (unauthenticated, but useless without the secret) and shows her who's inviting her, at
   what endpoint, and what tier.
5. Alice confirms.
6. Alice's CLI redeems the invite over HTTP; Bob's daemon verifies the secret, mints a token,
   writes his own config entry for "alice", and returns the token and his ask URL.
7. Alice's CLI writes her own config entry for "bob" and stores the token.
8. Alice can now use `ask_peer` to reach Bob's agent, at the tier Bob proposed — immediately,
   with no restart on either side.

This keeps the user in control while removing the worst of the setup friction: no
`openssl rand`, no `jazz peers set-token` run twice, no hand-edited config file.

---

## Why this is better than public discovery

Public discovery answers "who is there?".

Peer invites answer "who did I choose to trust?".

That distinction matters. Discovery can help you find candidates, but invites actually create the relationship. For Jazz, that is the right boundary.

---

## Why HTTP can stay for now

The current peer model already uses HTTP cleanly:

- easy to bind on loopback, LAN, or public TLS behind a proxy
- easy to inspect while developing
- easy to integrate with the existing daemon
- easy to keep compatible with the current `POST /peer/ask` shape

Moving to gRPC/protobuf would not solve the bootstrap problem. It would mostly change the wire format.

If Jazz later grows toward richer cross-runtime interop, a protocol layer can be revisited. The invite model does not depend on that decision.

---

## Decisions this made

The design docs originally left these open; here's what shipped, and why.

- **One-way only, no separate "mutual" mode.** Running the flow twice, once per direction,
  already composes correctly because acceptance merges into an existing peer entry rather than
  replacing it. A `--mutual` flag would only save one command; not worth doubling the
  token/config-write logic on day one for that.
- **Plain HTTP(S) URLs, not `jazz://`.** A custom scheme would still have to encode the same
  host, port, invite id, and secret — a second parser for the same data.
- **QR is built in** (`--qr` on `invite create`), not deferred.
- **The proposed tier is fixed at creation time.** Letting the acceptor negotiate a different
  tier than what was offered would mean the inviter never actually decided what they were
  granting — the confirmation step shows the tier, it does not let anyone renegotiate it.

---

## Related

- [Peers](./peers.md) — the current peer model and tiers
- [Setting up peers](../guide/peers-setup.md) — the existing manual flow
- [Tools](./tools.md) — disclosure levels and why peers are read-only
- [Security](../../SECURITY.md) — the threat model this sits inside
