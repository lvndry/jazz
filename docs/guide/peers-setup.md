---
description: "Hands-on setup for peer links between two Jazz machines: approval tiers, the request ledger, and what each side can and cannot do to the other."
---

# Setting up peers

A hands-on walkthrough for letting your agent ask a friend's agent something, and letting
theirs ask yours. For the policy this is built on — tiers, the ledger, what no tier ever
permits — read [Peers](../concepts/peers.md) first; this page assumes you've seen it.

You need three things, in order: something worth asking, someone willing to answer it, and a
shared secret only the two of you know. Everything else is which network sits between you,
and that's the actual difference between the three setups below:

|                                        | Where the daemon binds   | Encryption            | Needs a domain? |
| -------------------------------------- | ------------------------ | --------------------- | --------------- |
| [One machine](#one-machine-two-agents) | loopback                 | none needed           | no              |
| [A tailnet](#over-a-tailnet)           | the tailnet interface    | Tailscale's WireGuard | no              |
| [The internet](#over-the-internet)     | loopback, behind a proxy | TLS at the proxy      | yes             |

Pick the one that matches your actual situation — they don't build on each other.

Every walkthrough below gets the shared secret onto both machines with an
[invite](../concepts/peer-invites.md): whichever side will *answer* creates a link, the other
side accepts it, and nobody types or pastes a token. Each section also shows the manual way —
generate one with `openssl`, run `jazz peers set-token` on both sides, edit config by hand —
as a fold-out, for when you'd rather not have acceptance write your config for you, or you're
scripting setup somewhere a human won't be there to confirm a link.

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

### 1. Bob starts serving

```bash
JAZZ_HOME=$BOB jazz daemon --serve-peers bob --port 4748
```

Loopback by default, so nothing outside this machine can reach it. Leave this running in its
own terminal.

### 2. Bob invites Alice

```bash
JAZZ_HOME=$BOB jazz peers invite create alice --port 4748 --disclosure internal --expires 1h
```

`disclosure` is the tier — see the [tier table](../concepts/peers.md#tiers-what-a-peer-may-learn).
Start at `internal`, not `private`: you want to see a refusal happen before you see an
answer. This prints a link; send it to Alice out of band (a chat message, not a commit).

### 3. Alice accepts

```bash
JAZZ_HOME=$ALICE jazz peers invite accept <the-link-bob-sent>
```

Alice sees who invited her, at what endpoint, and what tier, confirms once, and both sides are
done — her config now has Bob as a peer she can ask, and his has her as a peer who may learn
`internal`, with a token stored in each machine's keyring that neither of you had to generate.

<details>
<summary>Prefer to do it by hand?</summary>

Skip steps 2–3 above and do this instead, before step 1 (starting the daemon):

Edit `$BOB/config.json` and add Alice as a peer:

```jsonc
{
  "peers": [{ "name": "alice", "url": "http://127.0.0.1:4748/peer/ask", "disclosure": "internal" }],
}
```

Generate a shared token and put it on both sides — both store it under the *other's* name,
since Bob's copy answers "is this really Alice?" and Alice's copy answers "here's what I
present as Alice":

```bash
export TOKEN=$(openssl rand -hex 24)

JAZZ_HOME=$BOB   JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token alice
JAZZ_HOME=$ALICE JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token bob
```

Then add the same peer to `$ALICE/config.json`, this time from her side (url pointing at Bob's
daemon, no `disclosure` needed — tiers only matter to whoever is answering):

```jsonc
{ "peers": [{ "name": "bob", "url": "http://127.0.0.1:4748/peer/ask" }] }
```

</details>

### 4. Give Alice the tool

```bash
JAZZ_HOME=$ALICE jazz agent edit alice
```

Tick `ask_peer` in the toolset. It only appears at all once a peer is configured — a tool the
model can see is a tool it will try, so it stays absent otherwise.

### 5. Ask

```bash
JAZZ_HOME=$ALICE jazz run --agent alice "ask bob's agent what time it is on his machine"
```

`internal` admits `get_time`, so this should come back with an answer, attributed and quoted.
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

### 2. Bob serves on the tailnet interface — not `0.0.0.0`

```bash
jazz daemon --serve-peers bob --host 100.101.102.103
```

Bind the specific tailnet address, not `0.0.0.0`. If this machine also has a public interface
(a cloud VM with a tailnet sidecar, say), `0.0.0.0` would listen on that too — binding the
`100.x` address keeps the daemon reachable only from the tailnet, which is the whole reason to
use one. A bearer token is still required to reach the operator routes, because the
bind-safety check has no way to know *which* non-loopback interface is safe — it treats all of
them the same, on purpose. The first run generates one and stores it in the OS keyring,
printing it once — but on a headless server there usually is no keyring (`secret-tool` needs a
running D-Bus session and a keyring daemon, which nothing ever starts without a desktop
login), so the daemon will refuse to start and explain exactly that. On a server, set the
token yourself instead of chasing a keyring:

```bash
export JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24)
```

and persist that value the way you'd persist any other server secret — a systemd
`Environment=` line, an `.env` file whatever supervises the process reads, or a secrets
manager if the host already has one. This is the normal path for a server, not a fallback:
the keyring exists for a workstation where a human is already logged in, not the other way
around.

**Running the command above by hand only lasts until you Ctrl+C or close the session** —
`jazz daemon` forks nothing and writes no pidfile on purpose (supervision is the host's job).
To make it a real persistent service instead, run it as root:

```bash
sudo jazz daemon --serve-peers bob --host 100.101.102.103
```

and it offers to install itself as a systemd unit (or a launchd daemon on macOS) right there —
confirm once and it writes the unit, enables it, and starts it via `systemctl`/`launchctl`, so
it survives reboots and closed sessions. Running the plain command without `sudo` just gives
you a one-line tip pointing at `jazz daemon install` instead of failing; nothing here ever
invokes `sudo` on its own. Check on it afterward with `systemctl status jazz-daemon` (or
`launchctl list | grep jazz` on macOS), and remove it again with `sudo jazz daemon uninstall`.

### 3. Bob invites Alice

```bash
jazz peers invite create alice --host 100.101.102.103 --disclosure internal --expires 1h
```

Plain `http://` in the printed link, deliberately — Tailscale's WireGuard tunnel already
encrypts everything between the two machines, and a raw TCP connection to a `100.x` address
only ever reaches a node on your own tailnet. There is nothing TLS would add here, so the
invite command won't warn about it either.

### 4. Alice accepts

```bash
jazz peers invite accept <the-link-bob-sent>
```

<details>
<summary>Prefer to do it by hand?</summary>

In Alice's `~/.jazz/config.json`:

```jsonc
{ "peers": [{ "name": "bob", "url": "http://100.101.102.103:4747/peer/ask" }] }
```

In Bob's `~/.jazz/config.json`:

```jsonc
{
  "peers": [
    { "name": "alice", "url": "http://<alice's-tailnet-ip>:4747/peer/ask", "disclosure": "internal" },
  ],
}
```

Then the shared token, one command per side (both stored under the *other's* name):

```bash
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token alice   # on Bob's machine
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token bob     # on Alice's machine
```

</details>

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
TLS and forwards only the paths that peers actually need, so the daemon's operator routes
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

### 2. Bob's proxy forwards two paths

```caddyfile
bob-agent.example.com {
    reverse_proxy /peer/ask 127.0.0.1:4747
    reverse_proxy /peer-invites/* 127.0.0.1:4747
}
```

Anything else gets Caddy's default 404 — `/runs` and `/health` are never proxied, so they
simply don't exist from the internet's point of view, whatever the daemon itself is willing to
answer on loopback. `/peer-invites/*` only ever needs to be reachable long enough for one
redemption; nothing stops you from removing that line again afterward.

### 3. Bob invites Alice

```bash
jazz peers invite create alice --public-url https://bob-agent.example.com --disclosure internal --expires 1h
```

`--public-url` overrides what would otherwise be `http://127.0.0.1:4747` — the daemon's real
bind address, which Alice cannot reach — with the domain the proxy actually fronts. Without
it, the printed link would point nowhere useful to her.

### 4. Alice accepts

```bash
jazz peers invite accept <the-link-bob-sent>
```

<details>
<summary>Prefer to do it by hand?</summary>

```jsonc
{ "peers": [{ "name": "bob", "url": "https://bob-agent.example.com/peer/ask" }] }
```

```jsonc
{
  "peers": [
    { "name": "alice", "url": "https://alice-agent.example.com/peer/ask", "disclosure": "internal" },
  ],
}
```

```bash
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token alice   # on Bob's machine
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token bob     # on Alice's machine
```

Send that secret out of band — a chat message, not a commit, not a URL. It's a bearer
credential for someone else's agent to use on yours.

</details>

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
  answering side. If you set it up by hand, re-run `peers set-token` on both ends with the
  exact same value; if you used an invite, the link may have been redeemed already — create a
  new one.
- **403, `"not accepting questions"`** — the peer exists in config but has no `disclosure`,
  which defaults to `none`. Add a tier.
- **403, some other reason, with a ledger entry** — the question was refused *by the agent*,
  not the connection. Read the reason in `jazz peers log`; it's usually the tier working as
  designed.
- **`ask_peer` doesn't show up in the toolset** — no peer is configured on that side yet, or
  every configured peer is at `disclosure: "none"`. The tool is deliberately absent until there's
  somewhere for it to go.
- **The daemon refuses to start** — read the message; it's almost always `--host` set to
  something other than loopback with no token available. That check exists because a daemon
  on a reachable interface is an agent with filesystem access that anyone reaching the port
  can drive. The message explains specifically why (no keyring found, or one found but the
  write to it failed) and gives the fix that works regardless — set `$JAZZ_DAEMON_TOKEN`
  yourself and persist it the way you'd persist any other server secret.
- **The invite link doesn't work** — check it hasn't expired or already been redeemed
  (`jazz peers invite list` on the inviter's machine), and that the inviter's daemon is
  actually running at the address embedded in the link.

## Next steps

- [Peer invites](../concepts/peer-invites.md) — how the invite flow works and why it's shaped
  the way it is
- [Peers](../concepts/peers.md) — the tier model, the ledger, and what this does not protect
  you from
- [`jazz daemon`](../reference/cli.md#jazz-daemon) — the HTTP server peers runs on top of
- [Tools](../concepts/tools.md) — what `public`/`internal`/`private` mean, and why tiers are
  built on that axis instead of risk
