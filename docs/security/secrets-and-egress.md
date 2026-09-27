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

The OS keyring is shared by every Jazz home on the account, so each home files its entries under
its own service, `jazz.<hash of the home path>`. A `JAZZ_HOME` or `--data-dir` home cannot read the
keys of another. `jazz mcp add --env` and `--header` values are secrets too: they go to the keyring,
and `~/.agents/mcp.json` (mode 0600) keeps only their names.

Read-back is one-way. `jazz config show` and `jazz config get` redact every secret, including MCP
env and header values and values merged in from the keyring or the environment; `--reveal` is the
explicit exception. A token is printed once, when it is minted. Print it twice and it accumulates
in scrollback and supervisor logs.

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

Jazz can discover and copy credential files without putting their values in the model context.
`ls` and `find` include their paths with `protected: true`; `stat` provides metadata. Direct
`read_file`, `read_pdf`, `pdf_page_count` and `grep` calls return a successful metadata-only result
with `contentOmitted: true` and guidance to use `cp`. Searches spanning protected files omit their
contents. `write_file` and `edit_file` decline protected files before building a preview diff.

Protection covers:

- files named `.env`, `.env.*` (including examples) and `secrets.json`;
- the global config file (`$JAZZ_CONFIG_PATH`, or `$JAZZ_HOME/config.json`), which can hold a daemon token;
- Jazz's credential locks, temporary writes and corrupt-file quarantines;
- destinations previously copied or moved from protected files, including ordinary filenames;
- internal copy and replacement staging directories and their descendants.

Use `cp` with the source and final destination path for a whole-file transfer. The approval shows
paths, and the executor copies bytes internally; neither the proposal nor the result contains
values. Protected copies have mode `0600` for a file or `0700` for the containing directory.
Copying a directory with a protected descendant protects the entire destination tree. `mv`
preserves protection too. Individual secret-value reads and edits are not part of this workflow.

Before copying, Jazz records destination paths and their canonical aliases in the private
`$JAZZ_HOME/.protected-files.json` registry. Protection survives process restarts and subsequent
copies or moves through these tools. Records are append-only, including after a failed transfer
or deletion. Filesystem mutation tools prevent replacing or deleting the registry or its ancestors.
An unreadable or corrupt registry makes reads metadata-only and stops transfers until repaired.

This is a contract of Jazz's filesystem tools using the same `JAZZ_HOME`, not an OS sandbox.
Shell commands, external programs, hard-link aliases and runs using another home do not inherit
this registry. Credentials with other names, such as `~/.ssh` or a cloud CLI's token cache, are
not automatically recognized. Use a dedicated OS user or container where host isolation is needed
(see [unattended runs](./unattended-runs.md)).

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
of the config somebody handed you: it is read only from your global `~/.jazz/config.json`, and
applies only to servers defined in your own `~/.agents/mcp.json`. A repository's
`./.agents/mcp.json` can add servers, which stay untrusted, but cannot replace one of yours or
inherit its trust by reusing its name.

OAuth tokens are bound to the server's name and URL. A definition that reuses a name with another
URL gets no token.

An untrusted server's tools are not exposed broadly. Treat adding one the way you would treat
`curl | sh`, because the trust decision is the same shape.

## What this does not do

None of it replaces operating-system permissions or network isolation. A shell tool running as
your user reaches whatever your user reaches.

Scrubbing the environment stops a key being read out of `env`. It does not stop a read tool or a
shell command from reading `~/.aws/credentials`: the read tools protect recognized credential paths and recorded copies, and `execute_command` is gated by approval.

If that matters for your deployment, the answer is a dedicated OS user or a container, not a
tighter approval policy. See [unattended runs](./unattended-runs.md).
