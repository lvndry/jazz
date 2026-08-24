# Setting up peers

A hands-on walkthrough for letting your agent ask a friend's agent something, and letting
theirs ask yours. For the policy this is built on — tiers, the ledger, what no tier ever
permits — read [Peers](../concepts/peers.md) first; this page assumes you've seen it.

You need three things, in order: something worth asking, someone willing to answer it, and a
shared secret only the two of you know. Everything else is wiring.

---

## Try it on one machine first

Before involving a second computer, run both sides yourself with `JAZZ_HOME` pointed at two
separate directories. This is the whole feature, fully live, with nothing exposed to a
network.

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
Alice?", Alice's copy answers "here's what I present as Alice."

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

## Doing it for real, across two machines

Same five steps, three differences:

- **Networking is your job.** The daemon binds loopback; reaching it from another machine
  means a reverse proxy, a tailnet, or an SSH tunnel — whatever you'd use to expose any other
  local service. Nothing about peers changes that decision for you.
- **Binding beyond loopback needs `$JAZZ_DAEMON_TOKEN`.** This is a separate credential from
  the peer token: it gates the daemon's own operator routes (`/runs`, `/health`), not
  `/peer/ask`. The daemon refuses to start on a non-loopback host without it, as a check
  against exposing an agent with filesystem access by accident.

  ```bash
  JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24) jazz daemon --serve-peers bob --host 0.0.0.0
  ```

- **Send the peer token out of band** — a chat message, not a commit, not a URL. It's a
  bearer credential for your friend's agent.

Everything else — the config entry, `peers set-token`, `agent edit`, the ledger — is
identical to the local walkthrough above.

---

## If it doesn't answer

- **`POST /peer/ask` returns 404** — the daemon wasn't started with `--serve-peers`, or you
  hit the wrong port.
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

## Next steps

- [Peers](../concepts/peers.md) — the tier model, the ledger, and what this does not protect
  you from
- [`jazz daemon`](../reference/cli.md#jazz-daemon) — the HTTP server peers runs on top of
- [Tools](../concepts/tools.md) — what `public`/`internal`/`private` mean, and why tiers are
  built on that axis instead of risk
