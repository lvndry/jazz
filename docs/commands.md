---
description: "Every jazz command and flag, verified against the source: run agents, manage sessions, configure providers, and drive headless automation."
---

# Jazz commands and flags

This page helps you find the exact command and flag you need.

Verified against [`packages/runtime/src/cli-app.ts`](../packages/runtime/src/cli-app.ts). Run `jazz <command> --help`
for the same information at the terminal.

---

## Global options

Available on every command.

| Flag                | Effect                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v, --verbose`     | Verbose logging                                                                                                                                                             |
| `--debug`           | Debug-level logging                                                                                                                                                         |
| `--config <path>`   | Use a specific config file (also `JAZZ_CONFIG_PATH`)                                                                                                                        |
| `--data-dir <path>` | Directory holding this invocation's config, data, and keyring entries (overrides `$JAZZ_HOME`; defaults to `~/.jazz`). Lets one host run several independent agents by flag |
| `--no-tui`          | Disable the full-screen interface; use plain terminal output for CI, scripts, or small terminals. Same as `JAZZ_NO_TUI=1`                                                   |
| `--output <mode>`   | `rendered` \| `hybrid` (default) \| `raw` (no formatting) \| `quiet` (suppress output). Same as `JAZZ_OUTPUT_MODE`                                                          |
| `--version`         | Print the version                                                                                                                                                           |
| `--help`            | Print help                                                                                                                                                                  |

---

## `jazz`

With no arguments, launches the interactive wizard: new conversation, create/list/edit/delete
agents, update configuration. The home screen reports what is ready under **setup** (agents) and,
under **environment**, the same machine facts every agent receives in its system prompt: date,
OS with shell and user, working directory, and hardware. Both come from one source, so the screen
cannot drift from what agents are actually told. On a short terminal the environment report is the
first section dropped, after the tip.

---

## `jazz run`: headless, one-shot

The command every non-terminal integration is built on. Takes a dynamic prompt, runs one
agent turn, prints a clean payload. **stdout is the answer; all chatter goes to stderr.**

```bash
jazz run --agent <id> [prompt]
```

The prompt comes from the positional argument, or from piped stdin when the argument is
absent and stdin is not a TTY.

| Flag                           | Default      | Purpose                                                                                                                                               |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`                 | **required** | Agent id or name                                                                                                                                      |
| `--json`                       | off          | Emit one JSON envelope: `{ ok, answer, costUSD, tokenUsage, toolCalls }`                                                                              |
| `--conversation <id>`          | none         | Stable conversation key. Loads prior history before the run, saves the transcript after, which gives stateless bridges per-chat memory                     |
| `--approval-policy <p>`        | none         | `read-only` \| `low-risk` \| `high-risk`. Tools above the tier are **declined**                                                                       |
| `--auto-approve-tools <names>` | none         | Comma-separated tool names allowed regardless of policy; narrower than raising the whole tier                                                         |
| `--timezone <iana-tz>`         | UTC          | Time zone used to resolve reminder times, such as `Europe/Paris`                                                                                      |
| `--events <categories>`        | none         | NDJSON progress on stderr: `tools`, `reasoning`, `text`, `usage`, `approval`, `subagent`, `all` (comma-separated)                                     |
| `--reasoning <effort>`         | agent config | `low` \| `medium` \| `high` \| `disable`                                                                                                              |
| `--timeout <ms>`               | none         | Abort the run after this many milliseconds (hard external kill, no warning)                                                                           |
| `--max-iterations <n>`         | 100          | Cap reasoning iterations                                                                                                                              |
| `--max-cost-usd <$>`           | none         | Abort once cumulative spend (own + sub-agent) reaches this many dollars, checked between iterations                                                   |
| `--max-tokens <n>`             | none         | Abort once cumulative prompt + completion tokens (own run only, not sub-agents) reach this count, checked between iterations: needs no model pricing |
| `--max-duration-ms <ms>`       | none         | Abort once elapsed wall-clock time reaches this budget, with agent pressure nudges at 50/80/90%, checked between iterations                           |
| `--stream`                     | auto         | Force streaming. Required for `--events` in non-TTY contexts, where streaming auto-disables                                                           |
| `--no-stream`                  | off         | Disable streaming                                                                                                                                     |
| `--interactive-stdin`          | off          | Let a bridge relay questions and approvals as stdin/stdout events                                                                                     |
| `--ephemeral`                  | off          | Do not load or save Jazz conversation/session history; withhold long-term memory writes                                                               |
| `--history-json <json>`        | none         | Prior messages for an ephemeral run; the success envelope returns the updated `messages` array                                                        |
| `--park`                       | off          | Persist the run and exit `2` at an unanswered approval; resume it with `jazz runs approve`                                                            |
| `--with-vision <p/m>`          | agent config | Bind an image-analysis companion for this run                                                                                                         |
| `--with-audio <p/m>`           | agent config | Bind an audio-analysis companion for this run                                                                                                         |
| `--with-video <p/m>`           | agent config | Bind a video-analysis companion for this run                                                                                                          |

`--max-cost-usd`, `--max-tokens`, and `--max-duration-ms` are soft checkpoints, not preemptive
interrupts. See [Configuration → run budgets](./configure/jazz.md#run-budgets)
for the enforcement model and how they differ from `--timeout`.

**Exit codes:** `0` on success, `1` on failure. In plain mode stdout is empty on failure and
the message goes to stderr; in `--json` mode stdout always carries exactly one object.

Full contract, examples, and a complete bridge implementation:
[Surfaces → Headless](./surfaces/headless.md).

---

## `jazz agent`

| Command                             | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `jazz agent list`                   | List all agents; `--can image\|audio\|video` filters to the ones that can generate that medium |
| `jazz agent create`                 | Create an agent (interactive)                                     |
| `jazz agent show <agentId>`         | Show an agent's details                                           |
| `jazz agent edit <agentId>`         | Edit an agent                                                     |
| `jazz agent delete <agentId>`       | Delete an agent. `-y, --yes` / `-f, --force` to skip confirmation |
| `jazz agent chat <agentIdentifier>` | Interactive session with a specific agent, by id or name          |

`agent chat` accepts `--stream` / `--no-stream`, `--max-iterations <n>`, and `--ephemeral`.

---

## `jazz workflow`

| Command                           | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `jazz workflow list`              | List available workflows (built-in, global, local) |
| `jazz workflow show <name>`       | Show a workflow's prompt and metadata              |
| `jazz workflow run <name>`        | Run once. See flags below                         |
| `jazz workflow schedule <name>`   | Install into launchd (macOS) or cron (Linux)       |
| `jazz workflow unschedule <name>` | Remove from the scheduler                          |
| `jazz workflow scheduled`         | List scheduled workflows                           |
| `jazz workflow catchup`           | List workflows that missed a slot, select, run     |
| `jazz workflow history [name]`    | Show run history                                   |

### `jazz workflow run` flags

| Flag                     | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `--auto-approve`         | Apply the workflow's own `autoApprove:` policy instead of prompting         |
| `--agent <agentId>`      | Override the agent for this run                                             |
| `--max-iterations <n>`   | Override the workflow's iteration cap                                       |
| `--max-cost-usd <$>`     | Override the workflow's spend cap                                           |
| `--max-tokens <n>`       | Override the workflow's token cap                                           |
| `--max-duration-ms <ms>` | Override the workflow's wall-clock budget (50/80/90% agent pressure nudges) |
| `--json`                 | One JSON envelope on stdout; all chatter suppressed                         |
| `--timeout <ms>`         | Abort after this many milliseconds (hard external kill, no warning)         |
| `--events <categories>`  | NDJSON progress on stderr. **Requires `--json`**: otherwise it errors      |
| `--scheduled`            | Marks the run as scheduler-triggered (set automatically by launchd/cron)    |

Frontmatter fields: [Workflow frontmatter](./configure/workflows.md).

---

## `jazz mcp`

| Command               | Purpose                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz mcp add [json]` | Add a server from inline JSON, `--file <path>`, stdin, or by name with `--transport`, repeatable `--env`/`--header`, and optional `--trusted` |
| `jazz mcp list`       | List configured servers; `--tools` connects and discovers tools                                                                               |
| `jazz mcp test`       | Connect to one server and report its tools and capabilities                                                                                   |
| `jazz mcp auth`       | Complete OAuth 2.1 authorization for a remote server                                                                                          |
| `jazz mcp logout`     | Remove a remote server's stored OAuth credentials                                                                                             |
| `jazz mcp trust`      | Honor a server's read-only annotations when applying approval policy                                                                          |
| `jazz mcp untrust`    | Require approval for every tool from the server                                                                                               |
| `jazz mcp remove`     | Remove a server                                                                                                                               |
| `jazz mcp enable`     | Enable a disabled server                                                                                                                      |
| `jazz mcp disable`    | Disable a server                                                                                                                              |

See [MCP configuration](./configure/mcp.md).

---

## `jazz runs`

Inspect runs still in flight, including your own parked ones, and, once a daemon started
one, runs begun from somewhere else entirely.

| Command                     | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `jazz runs list`            | List unfinished runs, newest first. `--agent`, `--conversation`, `--all` (include finished, with cost), `--json` |
| `jazz runs show <runId>`    | Show one run, including what it's waiting for. `--json`                                                          |
| `jazz runs approve <runId>` | Approve what a parked run is waiting for; blocks until it finishes                                               |
| `jazz runs reject <runId>`  | Refuse what it's waiting for; `--note <text>` tells it why                                                       |
| `jazz runs answer <runId>`  | Answer a question the run asked, in your own words: `--response <text>` (empty declines it)                      |
| `jazz runs cancel <runId>`  | Abandon a parked run without answering it                                                                        |

A run parks when it hits something needing your approval and nobody is there to give it: see
[Daemon](#jazz-daemon) for answering one from a different process than the one that started it.

---

## `jazz daemon`

Serves runs over HTTP: start one, poll it, approve or reject what a parked one is waiting for
,  from a different terminal, a different process, or a different machine than the one that
began it. It backgrounds itself by default; use `--foreground` under your own supervisor.
`jazz daemon install` creates the systemd/launchd service for you.

| Flag                      | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `--port <n>`              | Port to listen on. Default `4747`                                               |
| `--host <address>`        | Interface to bind. Default `127.0.0.1`. Anything else requires a daemon token   |
| `--serve-peers <agentId>` | Also answer questions from configured peers, using this agent. Off unless given |
| `--foreground`            | Stay attached instead of spawning a background daemon                           |

A bearer token authenticates operator routes (`/runs`, `/health`) on every bind, including
loopback. On first start Jazz generates one, stores it in the OS keyring or its protected local
fallback, and prints it once. A non-loopback daemon refuses to start if no token can be supplied or
stored. When keyring storage is deliberately disabled, loopback alone may warn and continue without
one. `/peer/ask` uses separate per-peer credentials; see [`jazz peers`](#jazz-peers).

| Command                    | Purpose                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz daemon set-token`    | Generate (or store `$JAZZ_DAEMON_TOKEN` if set) a token before the daemon's first run: useful when a client needs the value in advance                                                                                                                                                     |
| `jazz daemon forget-token` | Remove the stored token                                                                                                                                                                                                                                                                     |
| `jazz daemon stop`         | Stop the background daemon listening on this port                                                                                                                                                                                                                                           |
| `jazz daemon install`      | Install this as a persistent system service (systemd/launchd). Needs root; generates and stores its own token if none is set (no keyring or `$JAZZ_DAEMON_TOKEN` needed); doesn't report success until `/health` answers; `--serve-peers <agentId>` (required), `--host`, `--port`, `--yes` |
| `jazz daemon uninstall`    | Remove the service installed by `install`. Needs root; `--yes`                                                                                                                                                                                                                              |

Set `$JAZZ_DAEMON_TOKEN` yourself instead of letting Jazz generate one when the value needs to
be known ahead of time: a client config written before the daemon has ever run, or an
ephemeral container whose `$JAZZ_HOME` doesn't survive to the next deploy.

See [Setting up peers](./guides/connect-peers.md) for a full walkthrough, and
[Agent-to-agent](./concepts/agent-to-agent.md) for the tier model this exists to serve.

`jazz wake-trigger fire --agent <agentId> --id <id>` is internal plumbing, not something you run
by hand: it's what `register_trigger` schedules with `launchd`/`at` to fire a wake trigger without
`jazz daemon` running. See [Wake Triggers](./tools/index.md#wake-triggers).

---

## `jazz imessage`

Reach the agent from Messages. The bare command uses a hosted Photon line and can run on any
supported host. `--local` instead uses the Apple account signed into a Mac (macOS 14+) and walks
through installing [`imsg`](https://github.com/openclaw/imsg), granting Full Disk Access, and
optionally installing a background service.

| Command                | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `jazz imessage`        | Start the bridge. `--local` uses your Mac account; `--agent <id-or-name>` seeds it from an existing agent |
| `jazz imessage status` | Whether the local-Mac background service is installed and loaded                                          |
| `jazz imessage logs`   | Follow the local-Mac service log at `~/.jazz-imessage/bridge.log` by default                              |
| `jazz imessage stop`   | Stop the local-Mac launchd service; its plist remains                                                     |

Who it answers is `IMESSAGE_ALLOWED_HANDLES`, deny-by-default; with nothing set, an
interactive first run answers only you, via a `jazz` prefix in a chat with yourself. The
background service's environment is snapshotted into its plist at install time: see
[Reaching your agent from a chat app](./guides/deploy-a-chat-agent.md#imessage) for changing it
afterwards, and
[`packages/imessage-bot/README.md`](../packages/imessage-bot/README.md) for every
variable.

---

## `jazz whatsapp`

Reach the agent from WhatsApp. The bridge links to your account as a device, the way
WhatsApp Web does, and runs in the foreground: there is no service installer.

| Command         | Purpose                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `jazz whatsapp` | Start the bridge. `--agent <id-or-name>` seeds it from an agent you have, copied into its home |

The first run asks whose messages to answer and remembers it in `wa-allowed.json`;
`WHATSAPP_ALLOWED_NUMBERS` skips the question and is required where there is no terminal to
ask. Pairing is a QR code, or an 8-character code with `WHATSAPP_PAIR_NUMBER` on a headless
machine, and happens once: credentials live in `WHATSAPP_AUTH_DIR`. See
[Reaching your agent from a chat app](./guides/deploy-a-chat-agent.md#whatsapp) for the walkthrough and
[`packages/whatsapp-bot/README.md`](../packages/whatsapp-bot/README.md) for every variable.

---

## `jazz peers`

Other people's agents this machine talks to, and what has been said to or by them.

| Command                          | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jazz peers list`                | List configured peers and what each may learn. `--json`                                              |
| `jazz peers set-token <name>`    | Store a peer's token, read from `$JAZZ_PEER_TOKEN` (or `--from-env <VAR>`)                           |
| `jazz peers forget-token <name>` | Remove a peer's stored token                                                                         |
| `jazz peers log`                 | Everything said to and by a peer, newest first. `--peer <name>`, `--limit <n>`, `--json`, `--follow` |

Peers can be added by [invite](./guides/connect-peers.md): `jazz peers invite create/accept`
,  or by editing `~/.jazz/config.json` directly. See [Setting up peers](./guides/connect-peers.md)
for both paths.

### `jazz peers invite`

| Command                           | Purpose                                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz peers invite create <name>` | Create a one-time invite link granting `<name>` a tier once accepted. `--disclosure <tier>` (required), `--persona <name>` (which persona answers them), `--expires <duration>`, `--host`/`--port` or `--public-url` (reverse-proxy setups), `--as <name>`, `--qr`, `--json` |
| `jazz peers invite accept <url>`  | Accept an invite link. `--as <name>`, `--yes` (skip confirmation), `--json`                                                                                                                                                                                                  |
| `jazz peers invite list`          | Invites created on this machine. `--json`                                                                                                                                                                                                                                    |
| `jazz peers invite revoke <id>`   | Invalidate an invite before it's redeemed                                                                                                                                                                                                                                    |

---

## `jazz persona`

| Command                            | Purpose                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `jazz persona list`                | List personas (built-in + custom)                                                                        |
| `jazz persona create`              | Create a custom persona (interactive)                                                                    |
| `jazz persona show <identifier>`   | Show a persona by name or id                                                                             |
| `jazz persona edit <identifier>`   | Edit a custom persona                                                                                    |
| `jazz persona delete <identifier>` | Delete a custom persona                                                                                  |
| `jazz persona browse`              | Browse the marketplace and install a persona (interactive). `--refresh`                                  |
| `jazz persona search`              | List every persona the marketplace offers. `--refresh`                                                   |
| `jazz persona install <name>`      | Install a marketplace persona. `--as <name>` (local name), `-y`/`--yes` (skip confirmation), `--refresh` |

`install` prints the full system prompt and asks before writing it: a persona becomes an agent's
instructions, so non-interactive runs must pass `--yes`. The catalog is cached under
`<jazz home>/cache/persona-registry.json` and keeps working offline; `JAZZ_PERSONA_REGISTRY_URL`
points Jazz at a self-hosted catalog.

See [Personas](./concepts/personas.md).

---

## `jazz config`

| Command                         | Purpose                       |
| ------------------------------- | ----------------------------- |
| `jazz config show`              | Show all configuration values |
| `jazz config get <key>`         | Get one value                 |
| `jazz config set <key> [value]` | Set one value                 |

See [Configuration](./configure/jazz.md).

---

## `jazz memory`

| Command                             | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `jazz memory list <agent>`          | List durable memory files available to an agent           |
| `jazz memory show <agent> <path>`   | Print one memory file as the agent reads it               |
| `jazz memory forget <agent> <path>` | Permanently delete one memory file                        |
| `jazz memory recall`                | Report memory consultation; `--surface <name>` filters it |

Conversation history and current working state are separate. See [Conversations, working state, and memory](./concepts/conversations-and-memory.md).

---

## `jazz webhook`

| Command                            | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `jazz webhook token <name>`        | Generate and store a bearer token; print it once |
| `jazz webhook forget-token <name>` | Remove a webhook's stored token                  |

Webhook definitions live in Jazz configuration. See [Webhooks](./concepts/webhooks.md).

---

## `jazz update`

| Command               | Purpose                              |
| --------------------- | ------------------------------------ |
| `jazz update`         | Update Jazz to the latest version    |
| `jazz update --check` | Check for updates without installing |

---

## In-chat commands

Available inside an interactive session. Type `/help` for the current list.

| Command      | Purpose                                               |
| ------------ | ----------------------------------------------------- |
| `/help`      | List commands                                         |
| `/tools`     | Show available tools                                  |
| `/skills`    | Browse skills                                         |
| `/workflows` | Browse workflows                                      |
| `/mode`      | Change approval mode (also Shift+Tab)                 |
| `/cost`      | Tokens and USD for this session, including sub-agents |
| `/context`   | Context window usage and the biggest consumers        |
| `/compact`   | Force context compaction now                          |
| `/switch`    | Switch agent                                          |
| `/peers`     | List configured peers and what each may learn or do   |
| `/new`       | Start a fresh conversation                            |

**Keys:** double-Escape interrupts generation or a running tool. Shift+Tab cycles the
approval policy. Shift+Enter inserts a newline in the composer; Enter sends.

### Shell escapes

In the interactive terminal, type `! <command>` when the agent asks you to run a command
yourself. Jazz executes the command in the current session directory and sends its bounded
stdout, stderr, and exit code to the agent as context for the next response:

```text
> ! ssh user@test rm -r folder
> Did that remove the folder successfully?
```

The command is executed because you entered it explicitly; it does not wait for the model to
call `execute_command`. The built-in shell denylist, sanitized environment, timeout, process
interruption, and 256 KiB per-stream output cap still apply. Output is treated as command data,
not as instructions. A non-zero exit code is still passed to the agent so it can explain or
suggest the next step. `!` is an interactive terminal feature and is not interpreted by
`jazz run`, scheduled jobs, CI, or chat bridges.

---

## Output modes

`--output` controls formatting; it does not change what goes to stdout vs stderr.

| Mode       | Behavior                                   |
| ---------- | ------------------------------------------ |
| `rendered` | Full markdown rendering                    |
| `hybrid`   | Default: rendered with plain fallbacks    |
| `raw`      | No formatting, no ANSI. **Use this in CI** |
| `quiet`    | Suppress output                            |

---

## Related

- [Surfaces → Headless](./surfaces/headless.md): the `jazz run` contract in depth
- [Configuration](./configure/jazz.md): config file and environment variables
- [Tools](./tools/index.md): every tool and its risk tier
- [Workflow frontmatter](./configure/workflows.md): the `WORKFLOW.md` fields
