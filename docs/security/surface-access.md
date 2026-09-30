---
description: "Authenticate every way into a Jazz agent: chat allowlists, webhook tokens and signatures, daemon and operator tokens, peer tiers, and checks before binding a public port."
---

# Surface access

Before exposing an agent to chat apps, webhooks, or peers, configure who can reach it
and which tools they may use. Keep the daemon on loopback unless you have configured
a private network or authenticated proxy.

The credential and permission controls differ by surface:

| Surface      | Who is authenticated   | Credential                                            | Bounded by                            |
| ------------ | ---------------------- | ----------------------------------------------------- | ------------------------------------- |
| **Chat bot** | a platform account     | platform allowlist of chat ids                        | the agent's own toolset               |
| **Webhook**  | one door, not a person | a per-webhook bearer token, or a signing secret       | `disclosure`, `allow`, and its budget |
| **Daemon**   | a client of the daemon | one bearer token; grants also need the operator token | the agent's own toolset               |
| **Peer**     | one agent identity     | a per-peer token, or an invite                        | `disclosure`, `allow`, and its budget |

The daemon token can start runs. Granting authority (accepting or resuming a
goal, starting or resuming a loop, approving or answering a parked run, and any write to an agent
or persona) also needs the operator token, which lives only in the OS keyring.

Peers and webhooks do not use it. A credential that can approve a file write is a much larger
grant than one that can ask a question.

## Chat bots

Set `TELEGRAM_ALLOWED_CHAT_IDS` to comma-separated chat IDs. Discord uses
`DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`, or `DISCORD_ALLOWED_GUILD_IDS`.
A guild grant admits everyone in that guild; prefer user or channel grants when appropriate.

Messages from anyone else are ignored.

Each allowlisted chat gets isolated conversation state. The Telegram and Discord bridges go
further when they run as root in the Linux container: each conversation's agent runs as its own
Unix user, under its own Jazz home. `JAZZ_BOT_CHAT_ISOLATION=0` turns this off. The iMessage,
WhatsApp, and Photon bridges do not do this; every chat shares one `JAZZ_HOME` and runs as the
bridge's user.

Where it applies, this prevents one person's agent from reading another's transcripts, memory,
or mail credentials.

See [chat surfaces](../surfaces/chat.md) for the per-platform setup.

## Webhooks and peers

Both hand a credential to somebody who is not you. Both are bounded on the same two axes: a
`disclosure` tier for what an answer may reveal, and a named `allow` list for anything that acts
or leaves the machine. [The security model](./index.md) has the rule.

Tokens live in the keyring, never in `config.json`, never in a URL, never in a log. Mint them
with `jazz webhook token <name>` and `jazz peers set-token <name>`, which print the value once.

A webhook fed by a service that signs its deliveries, GitHub among them, should use a
`signature` instead: `jazz webhook secret <name>` mints the shared secret, the sender signs each
body with it, and the secret never travels. A signed webhook also refuses a delivery it has
already run, by delivery id and by signature, so a captured request cannot be replayed.

Neither door ever tells a caller more than it must. An unknown webhook name answers the same
`401` as a bad credential, and a failed run answers "the run failed" or "could not answer"; the
cause goes to the daemon's log.

A run started through either door is a stranger's run:

- **None of your context.** No standing preferences from memory, no AGENTS.md, and no local file
  attached because the caller's text names a path.
- **A budget.** `budget.maxTokens`, `budget.maxCostUSD` and `budget.maxDurationMs` on the webhook
  or peer cap each run, and a run resumed after an approval gets only what it had left.
- **A concurrency cap.** `maxConcurrentRuns` (default 4) per webhook or peer. Past it the door
  answers `429` with `Retry-After`, instead of queueing work behind yours.
- **A bounded body.** 1 MiB for a webhook, 64 KB for a peer question or A2A request, refused
  while it streams.

A run that parks on an approval keeps all of this across the park: the same tool list, the same
caller, and the budget that is left. A remote run whose record lacks its tool list is refused
rather than resumed with the agent's whole toolset.

## The daemon

By default, every route except `GET /health` needs the daemon bearer token. If secret
storage is disabled and no token is supplied, a loopback daemon can run without one;
non-loopback startup requires a token. Keep authentication enabled on shared machines.
Requests with an `Origin` header are refused, and JSON routes require
`content-type: application/json`. See [Daemon](../concepts/daemon.md).

The bearer token cannot tell you from an agent. It sits in `$JAZZ_DAEMON_TOKEN` or, on a host
with no OS keyring, in `$JAZZ_HOME/secrets.json`, and an agent that can read a file and send a
request could replay it. So every grant also needs the operator token in
`X-Jazz-Operator-Token`. `jazz daemon operator-token` mints it into the OS keyring only (never the
file fallback, never an environment variable), refuses when a Jazz agent runs it, and a daemon an
agent started grants nothing. Without one, the daemon grants nothing over HTTP and you decide from
the CLI on the machine. See
[granting authority over HTTP](../concepts/daemon.md#granting-authority-over-http).

## Before you bind a public port

1. **Prefer private access.** Bind loopback and reach it over a tailnet or an SSH tunnel.
2. **Terminate TLS at a reverse proxy** you already run. Jazz speaks plain HTTP; a token over
   plain HTTP on a shared network is a token you have published.
3. **Scope who can reach the port,** with a firewall rule or a private network. Otherwise the
   token is the only thing between that interface and an agent with filesystem access.
4. **Run it as its own OS user,** with its own home, its own credentials, and no access to
   anything the job does not need. Jazz's tool controls bound what the model chooses to do; the
   operating system bounds what is reachable when that fails.
5. **Rotate on suspicion.** `jazz webhook token <name>`, `jazz webhook secret <name>`,
   `jazz peers set-token <name>` and `jazz daemon operator-token` overwrite;
   `jazz daemon forget-token` and `jazz daemon forget-operator-token` revoke. A rotated webhook or
   peer credential takes effect within 30 seconds, without a restart.

## Related

- [Security model](./index.md): risk, disclosure, and egress, and how a caller is bounded
- [Unattended runs](./unattended-runs.md): the checklist before automating anything
- [Threat model](./threat-model.md): what none of this stops
- [Daemon](../concepts/daemon.md) · [Webhooks](../concepts/webhooks.md) ·
  [Peers](../concepts/agent-to-agent.md) · [Chat surfaces](../surfaces/chat.md)
