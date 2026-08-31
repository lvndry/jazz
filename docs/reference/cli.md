---
description: "Every jazz command and flag, verified against the source: run agents, manage sessions, configure providers, and drive headless automation."
---

# CLI Reference

This page helps you find the exact command and flag you need.

Verified against [`packages/runtime/src/cli-app.ts`](../../packages/runtime/src/cli-app.ts). Run `jazz <command> --help`
for the same information at the terminal.

---

## Global options

Available on every command.

| Flag              | Effect                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-v, --verbose`   | Verbose logging                                                                                                    |
| `--debug`         | Debug-level logging                                                                                                |
| `--config <path>` | Use a specific config file (also `JAZZ_CONFIG_PATH`)                                                               |
| `--data-dir <path>` | Directory holding this invocation's config, data, and keyring entries (overrides `$JAZZ_HOME`; defaults to `~/.jazz`). Lets one host run several independent agents by flag |
| `--no-tui`        | Disable the Ink TUI; plain terminal output. For CI, scripts, small terminals. Same as `JAZZ_NO_TUI=1`              |
| `--output <mode>` | `rendered` \| `hybrid` (default) \| `raw` (no formatting) \| `quiet` (suppress output). Same as `JAZZ_OUTPUT_MODE` |
| `--version`       | Print the version                                                                                                  |
| `--help`          | Print help                                                                                                         |

---

## `jazz`

With no arguments, launches the interactive wizard — new conversation, create/list/edit/delete
agents, update configuration. The home screen reports what is ready under **setup** (agents) and,
under **environment**, the same machine facts every agent receives in its system prompt: date,
OS with shell and user, working directory, and hardware. Both come from one source, so the screen
cannot drift from what agents are actually told. On a short terminal the environment report is the
first section dropped, after the tip.

---

## `jazz run` — headless, one-shot

The command every non-terminal integration is built on. Takes a dynamic prompt, runs one
agent turn, prints a clean payload. **stdout is the answer; all chatter goes to stderr.**

```bash
jazz run --agent <id> [prompt]
```

The prompt comes from the positional argument, or from piped stdin when the argument is
absent and stdin is not a TTY.

| Flag                    | Default      | Purpose                                                                                                                           |
| ----------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`          | **required** | Agent id or name                                                                                                                  |
| `--json`                | off          | Emit one JSON envelope: `{ ok, answer, costUSD, tokenUsage, toolCalls }`                                                          |
| `--conversation <id>`   | none         | Stable conversation key. Loads prior history before the run, saves the transcript after — gives stateless bridges per-chat memory |
| `--approval-policy <p>` | none         | `read-only` \| `low-risk` \| `high-risk`. Tools above the tier are **declined**                                                   |
| `--events <categories>` | none         | NDJSON progress on stderr: `tools`, `reasoning`, `text`, `usage`, `approval`, `subagent`, `all` (comma-separated)                 |
| `--reasoning <effort>`  | agent config | `low` \| `medium` \| `high` \| `disable`                                                                                          |
| `--timeout <ms>`        | none         | Abort the run after this many milliseconds (hard external kill, no warning)                                                       |
| `--max-iterations <n>`  | 80           | Cap reasoning iterations                                                                                                          |
| `--max-cost-usd <$>`    | none         | Abort once cumulative spend (own + sub-agent) reaches this many dollars, checked between iterations                              |
| `--max-tokens <n>`      | none         | Abort once cumulative prompt + completion tokens (own run only, not sub-agents) reach this count, checked between iterations — needs no model pricing |
| `--max-duration-ms <ms>`| none         | Abort once elapsed wall-clock time reaches this budget, with agent pressure nudges at 50/80/90%, checked between iterations       |
| `--stream`              | auto         | Force streaming. Required for `--events` in non-TTY contexts, where streaming auto-disables                                       |
| `--no-stream`           | —            | Disable streaming                                                                                                                 |

`--max-cost-usd`, `--max-tokens`, and `--max-duration-ms` are soft checkpoints, not preemptive
interrupts — see [Configuration → `maxCostUSD`, `maxTokens`, and `maxDurationMs`](./configuration.md#maxcostusd-maxtokens-and-maxdurationms)
for the enforcement model and how they differ from `--timeout`.

**Exit codes:** `0` on success, `1` on failure. In plain mode stdout is empty on failure and
the message goes to stderr; in `--json` mode stdout always carries exactly one object.

Full contract, examples, and a complete bridge implementation:
[Surfaces → Headless](../surfaces/headless.md).

---

## `jazz agent`

| Command                             | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `jazz agent list`                   | List all agents                                                   |
| `jazz agent create`                 | Create an agent (interactive)                                     |
| `jazz agent show <agentId>`         | Show an agent's details                                           |
| `jazz agent edit <agentId>`         | Edit an agent                                                     |
| `jazz agent delete <agentId>`       | Delete an agent. `-y, --yes` / `-f, --force` to skip confirmation |
| `jazz agent chat <agentIdentifier>` | Interactive session with a specific agent, by id or name          |

`agent chat` accepts `--stream` / `--no-stream` and `--max-iterations <n>`.

---

## `jazz workflow`

| Command                           | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `jazz workflow list`              | List available workflows (built-in, global, local) |
| `jazz workflow show <name>`       | Show a workflow's prompt and metadata              |
| `jazz workflow run <name>`        | Run once — see flags below                         |
| `jazz workflow schedule <name>`   | Install into launchd (macOS) or cron (Linux)       |
| `jazz workflow unschedule <name>` | Remove from the scheduler                          |
| `jazz workflow scheduled`         | List scheduled workflows                           |
| `jazz workflow catchup`           | List workflows that missed a slot, select, run     |
| `jazz workflow history [name]`    | Show run history                                   |

### `jazz workflow run` flags

| Flag                    | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `--auto-approve`        | Apply the workflow's own `autoApprove:` policy instead of prompting      |
| `--agent <agentId>`     | Override the agent for this run                                          |
| `--max-iterations <n>`  | Override the workflow's iteration cap                                    |
| `--max-cost-usd <$>`    | Override the workflow's spend cap                                        |
| `--max-tokens <n>`      | Override the workflow's token cap                                        |
| `--max-duration-ms <ms>`| Override the workflow's wall-clock budget (50/80/90% agent pressure nudges) |
| `--json`                | One JSON envelope on stdout; all chatter suppressed                      |
| `--timeout <ms>`        | Abort after this many milliseconds (hard external kill, no warning)      |
| `--events <categories>` | NDJSON progress on stderr. **Requires `--json`** — otherwise it errors   |
| `--scheduled`           | Marks the run as scheduler-triggered (set automatically by launchd/cron) |

Frontmatter fields: [Workflow frontmatter](./workflow-frontmatter.md).

---

## `jazz mcp`

| Command               | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `jazz mcp add [json]` | Add a server from inline JSON, `-f, --file <path>`, or interactively |
| `jazz mcp list`       | List configured servers                                              |
| `jazz mcp remove`     | Remove a server                                                      |
| `jazz mcp enable`     | Enable a disabled server                                             |
| `jazz mcp disable`    | Disable a server                                                     |

See [Integrations → MCP](../integrations/mcp.md).

---

## `jazz runs`

Inspect runs still in flight — including your own parked ones, and, once a daemon started
one, runs begun from somewhere else entirely.

| Command                     | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `jazz runs list`            | List unfinished runs, newest first. `--agent`, `--conversation`, `--all` (include finished, with cost), `--json` |
| `jazz runs show <runId>`    | Show one run, including what it's waiting for. `--json`                                                          |
| `jazz runs approve <runId>` | Approve what a parked run is waiting for; blocks until it finishes                                               |
| `jazz runs reject <runId>`  | Refuse what it's waiting for; `--note <text>` tells it why                                                       |

A run parks when it hits something needing your approval and nobody is there to give it — see
[Daemon](#jazz-daemon) for answering one from a different process than the one that started it.

---

## `jazz daemon`

Serves runs over HTTP: start one, poll it, approve or reject what a parked one is waiting for
— from a different terminal, a different process, or a different machine than the one that
began it. Runs in the foreground; supervision (restart on crash, start on boot) is the host's
job, not the daemon's.

| Flag                      | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `--port <n>`              | Port to listen on. Default `4747`                                               |
| `--host <address>`        | Interface to bind. Default `127.0.0.1`. Anything else requires a daemon token   |
| `--serve-peers <agentId>` | Also answer questions from configured peers, using this agent. Off unless given |

A bearer token authenticates the operator routes (`/runs`, `/health`) whenever `--host` is
anything but loopback; loopback needs none. The first time this daemon binds a non-loopback
host with no token already set, Jazz generates one and stores it in the OS keyring, printing
it once so it can be copied to a client — the daemon works from the first run, with no setup
command required. `/peer/ask` (when `--serve-peers` is given) uses a separate, per-peer
credential instead — see [`jazz peers`](#jazz-peers).

| Command                    | Purpose                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz daemon set-token`    | Generate (or store `$JAZZ_DAEMON_TOKEN` if set) a token before the daemon's first run — useful when a client needs the value in advance |
| `jazz daemon forget-token` | Remove the stored token                                                                                                                 |

Set `$JAZZ_DAEMON_TOKEN` yourself instead of letting Jazz generate one when the value needs to
be known ahead of time — a container with no persistent keyring across restarts, or a client
config that must be written before the daemon has ever started.

See [Setting up peers](../guide/peers-setup.md) for a full walkthrough, and
[Peers](../concepts/peers.md) for the tier model this exists to serve.

`jazz wake-trigger fire --agent <agentId> --id <id>` is internal plumbing, not something you run
by hand: it's what `register_trigger` schedules with `launchd`/`at` to fire a wake trigger without
`jazz daemon` running. See [Wake Triggers](./tools.md#wake-triggers).

---

## `jazz peers`

Other people's agents this machine talks to, and what has been said to or by them.

| Command                          | Purpose                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `jazz peers list`                | List configured peers and what each may learn. `--json`                                  |
| `jazz peers set-token <name>`    | Store a peer's token, read from `$JAZZ_PEER_TOKEN` (or `--from-env <VAR>`)               |
| `jazz peers forget-token <name>` | Remove a peer's stored token                                                             |
| `jazz peers log`                 | Everything said to and by a peer, newest first. `--peer <name>`, `--limit <n>`, `--json` |

Peers can be added by [invite](../concepts/peer-invites.md) — `jazz peers invite create/accept`
— or by editing `~/.jazz/config.json` directly. See [Setting up peers](../guide/peers-setup.md)
for both paths.

### `jazz peers invite`

| Command                              | Purpose                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `jazz peers invite create <name>`    | Create a one-time invite link granting `<name>` a tier once accepted. `--disclosure <tier>` (required), `--persona <name>` (which persona answers them), `--expires <duration>`, `--host`/`--port` or `--public-url` (reverse-proxy setups), `--as <name>`, `--qr`, `--json` |
| `jazz peers invite accept <url>`     | Accept an invite link. `--as <name>`, `--yes` (skip confirmation), `--json`                                       |
| `jazz peers invite list`             | Invites created on this machine. `--json`                                                                         |
| `jazz peers invite revoke <id>`      | Invalidate an invite before it's redeemed                                                                         |

---

## `jazz persona`

| Command                            | Purpose                               |
| ---------------------------------- | ------------------------------------- |
| `jazz persona list`                | List personas (built-in + custom)     |
| `jazz persona create`              | Create a custom persona (interactive) |
| `jazz persona show <identifier>`   | Show a persona by name or id          |
| `jazz persona edit <identifier>`   | Edit a custom persona                 |
| `jazz persona delete <identifier>` | Delete a custom persona               |

See [Personas](../concepts/personas.md).

---

## `jazz config`

| Command                         | Purpose                       |
| ------------------------------- | ----------------------------- |
| `jazz config show`              | Show all configuration values |
| `jazz config get <key>`         | Get one value                 |
| `jazz config set <key> [value]` | Set one value                 |

See [Configuration](./configuration.md).

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
| `/model`     | Switch model mid-conversation                         |
| `/mode`      | Change approval mode (also Shift+Tab)                 |
| `/cost`      | Tokens and USD for this session, including sub-agents |
| `/context`   | Context window usage and the biggest consumers        |
| `/compact`   | Force context compaction now                          |
| `/switch`    | Switch agent                                          |
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
| `hybrid`   | Default — rendered with plain fallbacks    |
| `raw`      | No formatting, no ANSI. **Use this in CI** |
| `quiet`    | Suppress output                            |

---

## Related

- [Surfaces → Headless](../surfaces/headless.md) — the `jazz run` contract in depth
- [Configuration](./configuration.md) — config file and environment variables
- [Tools](./tools.md) — every tool and its risk tier
- [Workflow frontmatter](./workflow-frontmatter.md) — the `WORKFLOW.md` fields
