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

`execute_command` does not inherit your whole environment. A variable is removed before the
command runs when a word of its name marks a secret (`SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`,
`PASSPHRASE`, `CREDENTIALS`, `APIKEY`, `AUTH`, `PASS`, `COOKIE`, or `KEY` after another word, as in
`APP_KEY`), or when it is one Jazz reads a secret from (`JAZZ_PEER_TOKEN_*`, `JAZZ_WEBHOOK_*`,
`JAZZ_NOTIFY_<TARGET>_WEBHOOK_URL` and the other notify target secrets). A model that decides to
`env` or to shell out to something chatty cannot hand your provider keys or a Discord webhook URL
to it. Words are matched whole, so `KEYBOARD_LAYOUT` and `TOKENIZER_PATH` pass through.

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

A URL that reaches this machine or your local network asks for approval instead of failing, and
approving adds the address to the global `network.allowPrivateHosts`, so the next request goes
through unasked. List hosts ahead of time in the same setting (see
[private network hosts](../configure/jazz.md#private-network-hosts)):

```json
{ "network": { "allowPrivateHosts": ["homeassistant.local", "192.168.1.0/24"] } }
```

A hostname entry allows whatever that name resolves to, so list names you control. An address or
CIDR entry allows those addresses behind any name. Only the global config file sets it.

## Secret values in tool output

Files read normally, whatever they hold: `read_file`, `grep`, `find`, `ls`, `cp` and `mv` treat
`.env`, `secrets.json`, `~/.zshrc` and `~/.jazz/config.json` like any other file. What Jazz holds
back is the secret values inside them. Every tool result passes through one redaction step before
anything logs it or shows it to the model, the transcript or an approver, so file contents, command
output, MCP and HTTP responses, errors, and approval previews are all covered.

Two passes replace secrets with `[redacted:<name>]`:

- **Values Jazz knows**, replaced exactly wherever they appear: every secret setting (provider API
  keys, OTLP headers, the daemon and operator tokens, peer and webhook tokens, webhook signing
  secrets, notify target secrets), as resolved from the keyring, the environment or the config
  file; MCP env and header values whose name marks a secret (`SIGNOZ_API_KEY`, `Authorization`);
  and every environment variable of the Jazz process whose name marks it as a secret (`*_API_KEY`,
  `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, `*_PASS`, `JAZZ_NOTIFY_*_WEBHOOK_URL`, ...). The
  placeholder names the setting or variable, for example `[redacted:llm.openai.api_key]`. Values
  held only in the keyring are looked up again after a config change and at most once a minute.
- **Secrets Jazz never saw**, recognized by their shape: `NAME=value` lines and YAML `name: value`
  lines whose name marks a secret (`.env` files, shell profiles, `env` output, compose files,
  kubeconfig, diff lines, including coloured ones), quoted secret-named literals in JSON, YAML and
  source (`"apiKey": "..."`, also JSON-escaped), `.netrc` passwords, private key blocks (also when
  the end marker is cut off), JWTs, Discord and Slack webhook URLs, `Bearer`/`Basic` credentials,
  passwords in URLs, and the key formats of OpenAI, Anthropic, GitHub, Slack, AWS, Google, Stripe,
  npm and Telegram. A name marks a secret when its last word does (`DB_PASSWORD`, `APP_KEY`,
  `refresh_token`), so `TOKEN_URL`, `token_type` and `max_tokens` are left alone. `$VAR` references,
  templates, `<placeholders>`, booleans, paths and values shorter than 8 characters (for known
  values) are left alone.
- **Structured results by key**: in an HTTP response body or an MCP tool's structured content,
  a string under a secret-named key (`access_token`, `client_secret`, `password`) is replaced
  whole.

`write_file` and `edit_file` refuse text that contains a `[redacted:` placeholder, so an edit copied
from redacted output cannot overwrite the real value. The agent can still change a `.env` file: it
edits the lines around a secret, or replaces a secret line with a new value you asked for.

Recognition by shape is best-effort. A secret with an unrecognized name and format, or one a shell
pipeline transforms before it reaches a tool result (base64, splitting it across lines), is not
caught. Shell children also lose credential-named environment variables (see below), and host
isolation remains the job of a dedicated OS user or container (see
[unattended runs](./unattended-runs.md)).

## Content from outside is labelled

Results that carry someone else's words arrive inside an `<untrusted-content>` envelope that names
the source before and after the text: `web_fetch`, `web_search`, `http_request`, `read_pdf` URLs,
MCP tools and resources, `ask_peer`, the output of every `execute_command` and custom command
tool, and `read_file` of a file outside the working directory. Command output counts because Jazz
cannot tell what a command read: `himalaya` printing your inbox and `ls` look the same from
outside. The system prompt tells the model to read that content as data and to take instructions
only from you. After a run reads external content, egress tools need approval below `high-risk`;
see [unattended runs](./unattended-runs.md#egress-after-untrusted-input).

External-content exposure is also recorded as host-owned transcript metadata. Clearing tool
output and automatic or manual compaction carry that restriction forward; saving and resuming
that conversation still requires approval for new destinations under `read-only` and `low-risk`.
The model's summary cannot remove the restriction. Older transcripts still containing an external
tool envelope remain restricted, but exposure already lost from an older compacted transcript
cannot be recovered.

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
