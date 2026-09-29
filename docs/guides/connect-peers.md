---
description: "Hands-on setup for peer links between two Jazz machines: approval tiers, the request ledger, and what each side can and cannot do to the other."
---

# Setting up peers

Connect two Jazz installations so their agents can ask each other for help.
Read [Agent-to-agent](../concepts/agent-to-agent.md) for disclosure tiers and request logging.

Use peers when each installation needs to keep its own credentials and permissions:

- a personal planning agent can ask a company-hosted engineering agent for repository status without receiving company credentials;
- a laptop agent can ask a home-server agent to inspect local services without exposing that machine's filesystem tools to the laptop;
- a low-cost local agent can escalate one difficult question to a separately operated specialist;
- two collaborators can let their agents coordinate while each side controls what its own agent may disclose and execute.

The receiving Jazz installation chooses the model, persona, tools, and disclosure ceiling. The caller sends a request; it never lends its permissions or dictates how the other machine executes it.

Choose the setup that matches your network:

|                                        | Where the daemon binds   | Encryption            | Needs a domain? |
| -------------------------------------- | ------------------------ | --------------------- | --------------- |
| [One machine](#one-machine-two-agents) | loopback                 | none needed           | no              |
| [A tailnet](#over-a-tailnet)           | the tailnet interface    | Tailscale's WireGuard | no              |
| [The internet](#over-the-internet)     | loopback, behind a proxy | TLS at the proxy      | yes             |

The answering side creates an invite link; the caller accepts it to configure the
connection and shared credential. Each setup also includes manual configuration.

**Where the token lives:** an OS keyring when one's reachable (Keychain on macOS,
`secret-tool`/libsecret on Linux), otherwise a `chmod 600` file at `$JAZZ_HOME/secrets.json`.
Not in `config.json`. The file fallback needs no D-Bus session or keyring unlock, so it works
the same on a workstation and a headless server. `jazz peers invite accept` and
`jazz peers set-token` need no special-casing either way. `$JAZZ_DISABLE_KEYRING` turns off
both if you'd rather manage tokens yourself.

---

## One machine, two agents

Use two separate `JAZZ_HOME` directories to test both sides on one machine.

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

The daemon runs in the background and listens only on loopback.
Stop it with `JAZZ_HOME=$BOB jazz daemon stop --port 4748`.

### 2. Bob invites Alice

```bash
JAZZ_HOME=$BOB jazz peers invite create alice --port 4748 --disclosure internal --expires 1h
```

`disclosure` is the tier. See the [tier table](../security/index.md#how-the-ceiling-is-computed).
Start at `internal`, not `private`: you want to see a refusal happen before you see an
answer. This prints a link; send it to Alice out of band (a chat message, not a commit).

### 3. Alice accepts

```bash
JAZZ_HOME=$ALICE jazz peers invite accept <the-link-bob-sent>
```

Alice sees who invited her, at what endpoint, and what tier, confirms once, and both sides are
done: her config now has Bob as a peer she can ask, and his has her as a peer who may learn
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

Generate a shared token and put it on both sides: both store it under the _other's_ name,
since Bob's copy answers "is this really Alice?" and Alice's copy answers "here's what I
present as Alice":

```bash
export TOKEN=$(openssl rand -hex 24)

JAZZ_HOME=$BOB   JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token alice
JAZZ_HOME=$ALICE JAZZ_PEER_TOKEN=$TOKEN jazz peers set-token bob
```

Then add the same peer to `$ALICE/config.json`, this time from her side (url pointing at Bob's
daemon, no `disclosure` needed: tiers only matter to whoever is answering):

```jsonc
{ "peers": [{ "name": "bob", "url": "http://127.0.0.1:4748/peer/ask" }] }
```

</details>

### 4. Give Alice the tool

```bash
JAZZ_HOME=$ALICE jazz agent edit alice
```

Select `ask_peer` in the toolset. It appears only after a peer is configured.

### 5. Ask

```bash
JAZZ_HOME=$ALICE jazz run --agent alice "ask bob's agent what time it is on his machine"
```

Approve Alice's outgoing `ask_peer` call when prompted. `internal` admits Bob's
`get_time` tool, so the request should return his answer, attributed and quoted.
Now try something the tier doesn't cover:

```bash
JAZZ_HOME=$ALICE jazz run --agent alice "ask bob's agent to read his ~/.bashrc and summarize it"
```

Bob's agent should say it cannot, not because it decided to refuse, but because `read_file`
was never in its toolset for this run. There is no prompt to argue with.

### 6. Read the ledger, both sides

```bash
JAZZ_HOME=$BOB   jazz peers log   # what Bob was asked, and what he said
JAZZ_HOME=$ALICE jazz peers log   # what Alice asked, and what came back
```

Refused requests are logged with the reply.

---

## Over a tailnet

The setup for two machines that are both already on the same [Tailscale](https://tailscale.com)
network: a friend's laptop, a home server, a personal fleet. No public exposure, no domain,
no certificate: the tailnet is already a private, encrypted network, so the daemon just binds
to it directly instead of to loopback.

Alice and Bob each need Jazz installed and Tailscale connected to the same tailnet.

### 1. Bob finds his tailnet address

```bash
tailscale ip -4
# 100.101.102.103
```

MagicDNS gives the same machine a name too (`bob-machine.tailnet-name.ts.net`), if you'd
rather not hardcode an IP that Tailscale could reassign.

### 2. Bob installs the daemon as a persistent service on the tailnet interface

```bash
sudo jazz daemon install --serve-peers bob --host 100.101.102.103 --yes
```

Bind the specific tailnet address, not `0.0.0.0`. If this machine also has a public interface
(a cloud VM with a tailnet sidecar, say), `0.0.0.0` would listen on that too: binding the
`100.x` address keeps the daemon reachable only from the tailnet, which is the whole reason to
use one.

`daemon install` provisions an operator token in `/etc/jazz/daemon.env`, installs
the system service, and starts it. If startup fails, it prints a command for
reading the service logs.

Check on it anytime with `jazz daemon status` (or `systemctl status jazz-daemon`, or
`launchctl list | grep jazz` on macOS), read its output with `jazz daemon logs -f`, and remove it
again with `sudo jazz daemon uninstall`.

To test in the foreground first, run
`jazz daemon --foreground --serve-peers bob --host 100.101.102.103`.
Stop it with Ctrl+C.

### 3. Bob invites Alice

```bash
jazz peers invite create alice --host 100.101.102.103 --disclosure internal --expires 1h
```

The link uses `http://`; Tailscale encrypts traffic between the two machines.

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
    {
      "name": "alice",
      "url": "http://<alice's-tailnet-ip>:4747/peer/ask",
      "disclosure": "internal",
    },
  ],
}
```

Then the shared token, one command per side (both stored under the _other's_ name):

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
**the daemon itself never has to leave loopback**: a reverse proxy on Bob's box terminates
TLS and forwards only the paths that peers actually need, so the daemon's operator routes
(`/runs`, `/health`) remain private. Jazz provisions the daemon's operator token
even on loopback; peer requests use their separate peer credential.

This assumes Bob has a server with a public domain (`bob-agent.example.com` below) and a
reverse proxy already fronting it. [Caddy](https://caddyserver.com) is used here because it
gets you automatic TLS from a three-line config; nginx or anything else works the same way.

### 1. Bob starts the daemon, loopback only

```bash
jazz daemon --serve-peers bob
```

The daemon starts in the background on loopback. For restarts after a crash or
reboot, install it with `sudo jazz daemon install --serve-peers bob --yes`, or use
`--foreground` under your existing process supervisor.

### 2. Bob's proxy forwards two paths

```caddyfile
bob-agent.example.com {
    reverse_proxy /peer/ask 127.0.0.1:4747
    reverse_proxy /peer-invites/* 127.0.0.1:4747
}
```

Anything else gets Caddy's default 404. `/runs` and `/health` are never proxied, so they
simply don't exist from the internet's point of view, whatever the daemon itself is willing to
answer on loopback. `/peer-invites/*` only ever needs to be reachable long enough for one
redemption; nothing stops you from removing that line again afterward.

### 3. Bob invites Alice

```bash
jazz peers invite create alice --public-url https://bob-agent.example.com --disclosure internal --expires 1h
```

`--public-url` overrides what would otherwise be `http://127.0.0.1:4747`: the daemon's real
bind address, which Alice cannot reach: with the domain the proxy actually fronts. Without
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
    {
      "name": "alice",
      "url": "https://alice-agent.example.com/peer/ask",
      "disclosure": "internal",
    },
  ],
}
```

```bash
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token alice   # on Bob's machine
JAZZ_PEER_TOKEN=<shared-secret> jazz peers set-token bob     # on Alice's machine
```

Send that secret out of band: a chat message, not a commit, not a URL. It's a bearer
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

- **`POST /peer/ask` returns 404**: the daemon wasn't started with `--serve-peers`, the
  proxy isn't forwarding that path (internet setup), or you hit the wrong port/host.
- **401**: the token presented doesn't match what's stored for that peer's name on the
  answering side. If you set it up by hand, re-run `peers set-token` on both ends with the
  exact same value; if you used an invite, the link may have been redeemed already: create a
  new one.
- **403, `"not accepting questions"`**: the peer exists in config but has no `disclosure`,
  which defaults to `none`. Add a tier.
- **403, some other reason, with a ledger entry**: the question was refused _by the agent_,
  not the connection. Read the reason in `jazz peers log`; it's usually the tier working as
  designed.
- **413**: the question (or the A2A request carrying it) is over 64 KB.
- **429**: that peer already has `maxConcurrentRuns` questions in flight (4 unless its config
  says otherwise). Retry after the `Retry-After` seconds.
- **500, `"could not answer"`**: the answering run failed. The peer is never told why; the
  reason is in the answering daemon's log.
- **A new token is still refused**: the daemon trusts a token it read from the keyring for 30
  seconds. Wait that long after `peers set-token`, or restart the daemon.
- **`ask_peer` doesn't show up in the toolset**: no peer is configured on that side yet, or
  every configured peer is at `disclosure: "none"`. The tool is deliberately absent until there's
  somewhere for it to go.
- **The daemon refuses to start**: read the message; it's almost always `--host` set to
  something other than loopback with no token available. That check exists because a daemon
  on a reachable interface is an agent with filesystem access that anyone reaching the port
  can drive. Should be rare (see above): it means `$JAZZ_DISABLE_KEYRING` is set or
  `$JAZZ_HOME` isn't writable. Fix: set `$JAZZ_DAEMON_TOKEN` yourself and persist it the way
  you'd persist any other server secret.
- **The invite link doesn't work**: check it hasn't expired or already been redeemed
  (`jazz peers invite list` on the inviter's machine), and that the inviter's daemon is
  actually running at the address embedded in the link.

## Next steps

- [Agent-to-agent](../concepts/agent-to-agent.md): the tier model, the ledger, and what this does not protect
  you from
- [`jazz daemon`](../commands.md#jazz-daemon): the HTTP server peers runs on top of
- [Tools](../concepts/tools.md): what `public`/`internal`/`private` mean, and why tiers are
  built on that axis instead of risk
