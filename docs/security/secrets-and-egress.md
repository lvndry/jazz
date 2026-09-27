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

## Network egress

Every URL a model chooses goes through one guarded fetch: `http_request`, `web_fetch`, `read_pdf`
with a `url`, and whatever the HTML behind `create_pdf` and `create_composition` loads while it
renders. It enforces four things.

- **Public destinations.** The hostname is resolved, and every address it resolves to must be
  public. Loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
  link-local (`169.254/16`, which holds the cloud metadata service, and `fe80::/10`), CGNAT
  (`100.64/10`), `0.0.0.0`, IPv4-mapped IPv6 and the other special-purpose ranges are refused. The
  URL parser rewrites spellings like `2130706433`, `0x7f000001` and `0177.0.0.1` to `127.0.0.1`
  first, so they are refused too.
- **Every redirect hop.** Redirects are followed by hand, at most 20, and each target passes the
  same check before it is requested. An allowed host cannot bounce a request to metadata.
- **Credentials stay with their origin.** A cross-origin hop keeps only headers that carry no
  credential (`Accept`, `Content-Type`, `User-Agent` and the like). `Authorization`, `Cookie` and
  any custom header the model set are dropped. A cross-origin 307 or 308 that would resend the body
  is returned to the model instead of followed.
- **Bounded bodies.** Responses are streamed against the tool's byte cap and the timeout runs until
  the body is read, so an endless or slow response costs at most the cap and the timeout.

To let an agent reach a service on your own network, list it in the agent's
`network.allowPrivateHosts` (see [agent configuration](../configure/agents.md#network-access)):

```json
{ "network": { "allowPrivateHosts": ["homeassistant.local", "192.168.1.0/24"] } }
```

A hostname entry allows whatever that name resolves to, so list names you control. An address or
CIDR entry allows those addresses behind any name.

## Read tools and Jazz's secret files

`read_file`, `read_pdf`, `pdf_page_count`, `grep`, `find` and `ls` refuse Jazz's own secret files,
after resolving symlinks, so a model steered by something it read cannot put Jazz's keys in its
context:

- `$JAZZ_HOME/secrets.json`, the no-keyring secret store;
- the global config file (`$JAZZ_CONFIG_PATH`, or `$JAZZ_HOME/config.json`), which holds the
  daemon token when no keyring is available;
- the lock and temp files written beside them while they change.

A search that spans them, such as `grep` over `$JAZZ_HOME`, leaves their matches out.

Credentials other programs keep, such as `~/.ssh` or a cloud CLI's token cache, are not on the
list: Jazz cannot know every program's layout. Keep them out of the agent's reach with a dedicated
OS user or container (see [unattended runs](./unattended-runs.md)).

## Content from outside is labelled

Results that carry someone else's words arrive inside an `<untrusted-content>` envelope that names
the source before and after the text: `web_fetch`, `web_search`, `http_request`, `read_pdf` URLs,
MCP tools and resources, `ask_peer`, the output of every `execute_command` and custom command
tool, and `read_file` of a file outside the working directory. Command output counts because Jazz
cannot tell what a command read: `himalaya` printing your inbox and `ls` look the same from
outside. The system prompt tells the model to read that content as data and to take instructions
only from you. After a run reads external content, egress tools need approval below `high-risk`;
see [unattended runs](./unattended-runs.md#egress-after-untrusted-input).

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

Scrubbing the environment stops a key being read out of `env`. It does not stop a read tool or a
shell command from reading `~/.aws/credentials`: the read tools refuse only Jazz's own secret
files, and `execute_command` is gated by approval.

If that matters for your deployment, the answer is a dedicated OS user or a container, not a
tighter approval policy. See [unattended runs](./unattended-runs.md).
