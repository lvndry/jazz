# CLI Reference

This page helps you find the exact command and flag you need.

Verified against [`src/cli/cli-app.ts`](../../src/cli/cli-app.ts). Run `jazz <command> --help`
for the same information at the terminal.

---

## Global options

Available on every command.

| Flag              | Effect                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-v, --verbose`   | Verbose logging                                                                                                    |
| `--debug`         | Debug-level logging                                                                                                |
| `--config <path>` | Use a specific config file (also `JAZZ_CONFIG_PATH`)                                                               |
| `--no-tui`        | Disable the Ink TUI; plain terminal output. For CI, scripts, small terminals. Same as `JAZZ_NO_TUI=1`              |
| `--output <mode>` | `rendered` \| `hybrid` (default) \| `raw` (no formatting) \| `quiet` (suppress output). Same as `JAZZ_OUTPUT_MODE` |
| `--version`       | Print the version                                                                                                  |
| `--help`          | Print help                                                                                                         |

---

## `jazz`

With no arguments, launches the interactive wizard — new conversation, create/list/edit/delete
agents, update configuration.

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
| `--timeout <ms>`        | none         | Abort the run after this many milliseconds                                                                                        |
| `--max-iterations <n>`  | 80           | Cap reasoning iterations                                                                                                          |
| `--stream`              | auto         | Force streaming. Required for `--events` in non-TTY contexts, where streaming auto-disables                                       |
| `--no-stream`           | —            | Disable streaming                                                                                                                 |

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
| `--json`                | One JSON envelope on stdout; all chatter suppressed                      |
| `--timeout <ms>`        | Abort after this many milliseconds                                       |
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

## In-chat slash commands

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
approval policy.

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
