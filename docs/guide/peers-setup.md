# Setting up peers

A hands-on walkthrough for letting your agent ask a friend's agent something, and letting
theirs ask yours. For the policy this is built on — tiers, the ledger, what no tier ever
permits — read [Peers](../concepts/peers.md) first; this page assumes you've seen it.

You need three things, in order: something worth asking, someone willing to answer it, and a
shared secret only the two of you know. Everything else is which network sits between you,
and that's the actual difference between the three setups below:

| | Where the daemon binds | Encryption | Needs a domain? |
| --- | --- | --- | --- |
| [One machine](#one-machine-two-agents) | loopback | none needed | no |
| [A tailnet](#over-a-tailnet) | the tailnet interface | Tailscale's WireGuard | no |
| [The internet](#over-the-internet) | loopback, behind a proxy | TLS at the proxy | yes |

Pick the one that matches your actual situation — they don't build on each other.

---

## One machine, two agents

Run both sides yourself first, with `JAZZ_HOME` pointed at two separate directories. This is
the whole feature, fully live, with nothing exposed to a network — the fastest way to see the
tiers actually refuse something before you involve a second computer.

```bash
export ALICE=/tmp/jazz-alice
export BOB=/tmp/jazz-bob
JAZZ_HOME=$ALICE jazz agent create   # name it "alice"
JAZZ_HOME=$BOB   jazz agent create   # name it "bob"
```

### 1. Bob decides what Alice may learn

Edit `$BOB/config.json` and add Alice as a peer:

```jsonc
{
  "peers": [{ "name": "alice", "url": "http://127.0.0.1:4748/peer/ask", "may": "about-me" }]
}
```

`may` is the tier — see the [tier table](../concepts/peers.md#tiers-what-a-peer-may-learn).
Start at `about-me`, not `ask-me-anything`: you want to see a refusal happen before you see
an answer.

### 2. Agree on a token

A peer's token is a shared secret, not a login — whatever Alice presents has to equal what
Bob stored under her name. Generate one and put it on both sides:

```bash
export TOKEN=$(openssl rand -hex 24)

JAZZ_HOME=$BOB   JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token alice
JAZZ_HOME=$ALICE JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token bob
```

Yes, both sides store it under the *other's* name — Bob's copy answers "is this really
Alice?", Alice's copy answers "here's what I present as Alice." This is the same on all three
setups; the walkthroughs below won't repeat it.

### 3. Bob starts serving

```bash
JAZZ_HOME=$BOB jazz daemon --serve-peers bob --port 4748
```

Loopback by default, so nothing outside this machine can reach it. Leave this running in its
own terminal.

### 4. Give Alice the tool

```bash
JAZZ_HOME=$ALICE jazz agent edit alice
```

Tick `ask_peer` in the toolset. It only appears at all once a peer is configured — a tool the
model can see is a tool it will try, so it stays absent otherwise.

Alice also needs to know she's allowed to call Bob. Add the same peer entry to
`$ALICE/config.json`, this time from her side (url pointing at Bob's daemon, no `may` needed —
tiers only matter to whoever is answering):

```jsonc
{ "peers": [{ "name": "bob", "url": "http://127.0.0.1:4748/peer/ask" }] }
```

### 5. Ask

```bash
JAZZ_HOME=$ALICE jazz run --agent alice "ask bob's agent what time it is on his machine"
```

`about-me` admits `get_time`, so this should come back with an answer, attributed and quoted.
Now try something the tier doesn't cover:

```bash
JAZZ_HOME=$ALICE jazz run --agent alice "ask bob's agent to read his ~/.bashrc and summarize it"
```

Bob's agent should say it cannot — not because it decided to refuse, but because `read_file`
was never in its toolset for this run. There is no prompt to argue with.

### 6. Read the ledger, both sides

```bash
JAZZ_HOME=$BOB   jazz peers log   # what Bob was asked, and what he said
JAZZ_HOME=$ALICE jazz peers log   # what Alice asked, and what came back
```

The refused request shows up too, with the actual reply — that's the point of logging the
answer and not just the outcome.

---

## Over a tailnet

The setup for two machines that are both already on the same [Tailscale](https://tailscale.com)
network — a friend's laptop, a home server, a personal fleet. No public exposure, no domain,
no certificate: the tailnet is already a private, encrypted network, so the daemon just binds
to it directly instead of to loopback.

This assumes Alice and Bob each run `jazz` on their own machine (not `JAZZ_HOME` tricks — that
was only for sharing one machine above) and both have Tailscale installed and logged into the
same tailnet.

### 1. Bob finds his tailnet address

```bash
tailscale ip -4
# 100.101.102.103
```

MagicDNS gives the same machine a name too (`bob-machine.tailnet-name.ts.net`), if you'd
rather not hardcode an IP that Tailscale could reassign.

### 2. Alice adds Bob as a peer

In Alice's `~/.jazz/config.json`:

```jsonc
{ "peers": [{ "name": "bob", "url": "http://100.101.102.103:4747/peer/ask" }] }
```

Plain `http://`, deliberately — Tailscale's WireGuard tunnel already encrypts everything
between the two machines, and a raw TCP connection to a `100.x` address only ever reaches a
node on your own tailnet. There is nothing TLS would add here.

### 3. Bob decides Alice's tier and stores the token

In Bob's `~/.jazz/config.json`:

```jsonc
{
  "peers": [{ "name": "alice", "url": "http://<alice's-tailnet-ip>:4747/peer/ask", "may": "about-me" }]
}
```

Then the shared token, one command per side (see [step 2 above](#2-agree-on-a-token) for why
it's stored under the other person's name on both ends):

```bash
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token alice   # on Bob's machine
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token bob     # on Alice's machine
```

### 4. Bob serves on the tailnet interface — not `0.0.0.0`

```bash
JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24) jazz daemon --serve-peers bob --host 100.101.102.103
```

Bind the specific tailnet address, not `0.0.0.0`. If this machine also has a public interface
(a cloud VM with a tailnet sidecar, say), `0.0.0.0` would listen on that too — binding the
`100.x` address keeps the daemon reachable only from the tailnet, which is the whole reason to
use one. `$JAZZ_DAEMON_TOKEN` is still required, because the bind-safety check has no way to
know *which* non-loopback interface is safe — it treats all of them the same, on purpose.

### 5. Ask, from Alice's machine

```bash
jazz agent edit alice   # tick ask_peer
jazz run --agent alice "ask bob's agent what time it is on his machine"
```

Same verification as the one-machine walkthrough: `jazz peers log` on both sides afterward.

---

## Over the internet

For a peer that isn't on a private network with you at all. This needs a domain and TLS, but
**the daemon itself never has to leave loopback** — a reverse proxy on Bob's box terminates
TLS and forwards only the one path that peers actually need, so the daemon's operator routes
(`/runs`, `/health`) never become reachable from the internet even by accident. No
`$JAZZ_DAEMON_TOKEN` needed either, for the same reason: the daemon is never bound beyond
loopback.

This assumes Bob has a server with a public domain — `bob-agent.example.com` below — and a
reverse proxy already fronting it. [Caddy](https://caddyserver.com) is used here because it
gets you automatic TLS from a three-line config; nginx or anything else works the same way.

### 1. Bob starts the daemon, loopback only

```bash
jazz daemon --serve-peers bob
```

No `--host` flag — this is the default, and it's correct here. Run it under whatever already
supervises long-lived processes on this box (systemd, launchd, a container with
`restart: always`); the daemon itself has no pidfile or fork, by design, so something else
has to be the thing that restarts it if it dies.

### 2. Bob's proxy forwards one path

```caddyfile
bob-agent.example.com {
    reverse_proxy /peer/ask 127.0.0.1:4747
}
```

Anything other than `/peer/ask` gets Caddy's default 404 — `/runs` and `/health` are never
proxied, so they simply don't exist from the internet's point of view, whatever the daemon
itself is willing to answer on loopback.

### 3. Alice points at the public URL

```jsonc
{ "peers": [{ "name": "bob", "url": "https://bob-agent.example.com/peer/ask" }] }
```

`https`, this time — unlike the tailnet case, this connection crosses the open internet, and
TLS is what Caddy just set up in step 2.

### 4. Bob configures Alice's tier, and the token, exactly as before

```jsonc
{ "peers": [{ "name": "alice", "url": "https://alice-agent.example.com/peer/ask", "may": "about-me" }] }
```

```bash
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token alice   # on Bob's machine
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token bob     # on Alice's machine
```

Send that secret out of band — a chat message, not a commit, not a URL. It's a bearer
credential for someone else's agent to use on yours.

### 5. Ask, from Alice's machine

```bash
jazz agent edit alice   # tick ask_peer
jazz run --agent alice "ask bob's agent what time it is on his machine"
jazz peers log
```

---

## If it doesn't answer

- **`POST /peer/ask` returns 404** — the daemon wasn't started with `--serve-peers`, the
  proxy isn't forwarding that path (internet setup), or you hit the wrong port/host.
- **401** — the token presented doesn't match what's stored for that peer's name on the
  answering side. Re-run `peers set-token` on both ends with the exact same value.
- **403, `"not accepting questions"`** — the peer exists in config but has no `may`, which
  defaults to `none`. Add a tier.
- **403, some other reason, with a ledger entry** — the question was refused *by the agent*,
  not the connection. Read the reason in `jazz peers log`; it's usually the tier working as
  designed.
- **`ask_peer` doesn't show up in the toolset** — no peer is configured on that side yet, or
  every configured peer is at `may: "none"`. The tool is deliberately absent until there's
  somewhere for it to go.
- **The daemon refuses to start** — read the message; it's almost always
  `--host` set to something other than loopback with no `$JAZZ_DAEMON_TOKEN`. That check
  exists because a daemon on a reachable interface is an agent with filesystem access that
  anyone reaching the port can drive.

## Next steps

- [Peers](../concepts/peers.md) — the tier model, the ledger, and what this does not protect
  you from
- [`jazz daemon`](../reference/cli.md#jazz-daemon) — the HTTP server peers runs on top of
- [Tools](../concepts/tools.md) — what `public`/`internal`/`private` mean, and why tiers are
  built on that axis instead of risk
