---
description: "Where Jazz keeps credentials, what it strips from a shell environment, and why a read-only tool that talks to the network is a separate risk from one that writes."
---

# Secrets and egress

Reading data, revealing data, and sending data are three different properties. This page is
about the last two and about where credentials live.

## Where secrets live

Config writes route through the OS keyring, or a `chmod 600` `$JAZZ_HOME/secrets.json` where
there is no keyring.

One file decides which config paths hold a secret: `packages/adapters/src/secrets/registry.ts`.
That is why `jazz config set llm.openai.api_key` never lands in `config.json`.

Read-back is one-way. `jazz config show` redacts, and a token is printed once, when it is minted.
Print it twice and it accumulates in scrollback and supervisor logs.

Provider keys can also come from the environment, which is the normal path in a container where
no keyring exists. Never put a token in an agent prompt, a workflow file, or committed project
config. Those are the three places people put them.

## The shell environment is scrubbed

`execute_command` does not inherit your whole environment. Variables whose names match
`API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` are removed before the command runs, so a model
that decides to `env` or to shell out to something chatty cannot hand your provider keys to it.

When a command genuinely needs one, name it in the agent's `envAllowlist`. Per agent, explicit,
and visible in the agent file. The exception is written down rather than implied.

## Egress is its own axis

A tool that sends data off this machine is marked `egress`, independently of its risk level.

A read-only tool is not automatically safe. `web_search` mutates nothing and still hands your
query to a third party. `http_request` sends what the model chose, to a host the model chose.

This is why egress kicks a read-only tool out of a disclosure tier and into the explicit `allow`
list for peers and webhooks. "This caller may read" and "this caller may transmit" are different
grants, and [the security model](./index.md) keeps them separate.

The [tool inventory](../tools/index.md) lists exactly which tools send.

## MCP servers are external input

A server definition arrives from outside, including its command, its arguments, and the tools it
advertises.

Jazz records whether you trust it separately from the definition itself. Your trust is not part
of the config somebody handed you.

An untrusted server's tools are not exposed broadly. Treat adding one the way you would treat
`curl | sh`, because the trust decision is the same shape.

## What this does not do

None of it replaces operating-system permissions or network isolation. A shell tool running as
your user reaches whatever your user reaches.

Scrubbing the environment stops a key being read out of `env`. It does not stop a command reading
`~/.aws/credentials`.

If that matters for your deployment, the answer is a dedicated OS user or a container, not a
tighter approval policy. See [unattended runs](./unattended-runs.md).
