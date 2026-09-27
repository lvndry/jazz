---
description: "Authenticate every way into a Jazz agent: chat allowlists, per-webhook tokens and signatures, the daemon and operator tokens, and peer tiers, plus what to do before binding a public port."
---

# Surface access

Every remote surface has to answer three questions before a run starts: who may start work here,
which conversation do they resume, and what may that run reveal or execute.

The four surfaces answer them differently, and the differences are not arbitrary.

| Surface      | Who is authenticated   | Credential                                            | Bounded by                            |
| ------------ | ---------------------- | ----------------------------------------------------- | ------------------------------------- |
| **Chat bot** | a platform account     | platform allowlist of chat ids                        | the agent's own toolset               |
| **Webhook**  | one door, not a person | a per-webhook bearer token, or a signing secret       | `disclosure`, `allow`, and its budget |
| **Daemon**   | a client of the daemon | one bearer token; grants also need the operator token | the agent's own toolset               |
| **Peer**     | one agent identity     | a per-peer token, or an invite                        | `disclosure`, `allow`, and its budget |

Read the daemon row twice. Its token can start runs. Granting authority (accepting or resuming a
goal, starting or resuming a loop, approving or answering a parked run, and any write to an agent
or persona) also needs the operator token, which lives only in the OS keyring.

Peers and webhooks do not use it. A credential that can approve a file write is a much larger
grant than one that can ask a question.

## Chat bots

Set the platform allowlist and nothing else answers. `TELEGRAM_ALLOWED_CHAT_IDS` and its Discord
equivalent take comma-separated chat ids.

A message from anyone else is ignored, not refused. A refusal would confirm the bot exists.

Each allowlisted chat gets isolated conversation state. The Telegram bridge goes further: each
chat's agent runs as its own Unix user, under its own Jazz home.

So one person's agent cannot read another's transcripts, memory, or mail credentials. The kernel
enforces that, not a filename convention.

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

Loopback is not a trust boundary. Every route except `GET /health` needs the bearer token, and
two structural checks keep a browser out: a request carrying an `Origin` header is refused, and
JSON routes require `content-type: application/json`. [The daemon page](../concepts/daemon.md)
explains why both are necessary.

The bearer token cannot tell you from an agent. It sits in `$JAZZ_DAEMON_TOKEN` or, on a host
with no OS keyring, in `$JAZZ_HOME/secrets.json`, and an agent that can read a file and send a
request could replay it. So every grant also needs the operator token in
`X-Jazz-Operator-Token`. `jazz daemon operator-token` mints it into the OS keyring only (never the
file fallback, never an environment variable), refuses when a Jazz agent runs it, and a daemon an
agent started grants nothing. Without one, the daemon grants nothing over HTTP and you decide from
the CLI on the machine. See
[granting authority over HTTP](../concepts/daemon.md#granting-authority-over-http).

## Before you bind a public port

In rough order of how much each one saves you:

1. **Do not.** Bind loopback and reach it over a tailnet or an SSH tunnel. Most "remote access"
   needs are this, and it removes the entire class of problem.
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
