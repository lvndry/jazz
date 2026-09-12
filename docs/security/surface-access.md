---
description: "Authenticate every way into a Jazz agent: chat allowlists, per-webhook tokens, the daemon bearer token, and peer tiers, plus what to do before binding a public port."
---

# Surface access

Every remote surface has to answer three questions before a run starts: who may start work here,
which conversation do they resume, and what may that run reveal or execute.

The four surfaces answer them differently, and the differences are not arbitrary.

| Surface      | Who is authenticated   | Credential                     | Bounded by               |
| ------------ | ---------------------- | ------------------------------ | ------------------------ |
| **Chat bot** | a platform account     | platform allowlist of chat ids | the agent's own toolset  |
| **Webhook**  | one door, not a person | a per-webhook bearer token     | `disclosure` and `allow` |
| **Daemon**   | the operator           | one bearer token, all routes   | nothing; this is you     |
| **Peer**     | one agent identity     | a per-peer token, or an invite | `disclosure` and `allow` |

The daemon row is the one to read twice. Its token is operator-equivalent: it can start runs,
approve what they are parked on, and edit agents. Peers and webhooks deliberately do not use it,
because a credential that can approve a file write is a much larger grant than one that can ask a
question or fire a fixed prompt.

## Chat bots

Set the platform allowlist and nothing else answers. `TELEGRAM_ALLOWED_CHAT_IDS` and its Discord
equivalent are comma-separated chat ids; a message from anyone else is silently ignored rather
than refused, because a refusal confirms the bot exists.

Each allowlisted chat gets isolated conversation state. The Telegram bridge goes further and runs
each chat's agent as its own Unix user under its own Jazz home, so one person's agent cannot read
another's transcripts, memory, or mail credentials. That is the kernel enforcing it, not a
filename convention.

See [chat surfaces](../surfaces/chat.md) for the per-platform setup.

## Webhooks and peers

Both hand a credential to somebody who is not you, and both are bounded on the same two axes: a
`disclosure` tier for what an answer may reveal, and a named `allow` list for anything that acts
or leaves the machine. [The security model](./index.md) has the rule.

Tokens live in the keyring, never in `config.json`, never in a URL, never in a log. Mint them
with `jazz webhook token <name>` and `jazz peers set-token <name>`, which print the value once.

## The daemon

Loopback is not a trust boundary. Every route except `GET /health` needs the bearer token, and
two structural checks keep a browser out: a request carrying an `Origin` header is refused, and
JSON routes require `content-type: application/json`. [The daemon page](../concepts/daemon.md)
explains why both are necessary.

## Before you bind a public port

In rough order of how much each one saves you:

1. **Do not.** Bind loopback and reach it over a tailnet or an SSH tunnel. Most "remote access"
   needs are this, and it removes the entire class of problem.
2. **Terminate TLS at a reverse proxy** you already run. Jazz speaks plain HTTP; a token over
   plain HTTP on a shared network is a token you have published.
3. **Scope who can reach the port,** with a firewall rule or a private network. The token is the
   only thing between that interface and an agent with filesystem access, so do not let it be the
   only thing.
4. **Run it as its own OS user,** with its own home, its own credentials, and no access to
   anything the job does not need. Jazz's tool controls bound what the model chooses to do; the
   operating system bounds what is reachable when that fails.
5. **Rotate on suspicion.** `jazz webhook token <name>` and `jazz peers set-token <name>`
   overwrite; `jazz daemon forget-token` revokes.

## Related

- [Security model](./index.md): risk, disclosure, and egress, and how a caller is bounded
- [Unattended runs](./unattended-runs.md): the checklist before automating anything
- [Threat model](./threat-model.md): what none of this stops
- [Daemon](../concepts/daemon.md) · [Webhooks](../concepts/webhooks.md) ·
  [Peers](../concepts/agent-to-agent.md) · [Chat surfaces](../surfaces/chat.md)
