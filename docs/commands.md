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
| `--config <path>`   | Use a specific config file (also `JAZZ_CONFIG_PATH`). A path that does not exist, or a file that is not valid, stops the command with the reason and exit code `1`          |
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
first section dropped, after the tip. A randomly chosen tip highlights a chat command, agent
setting, tool, workflow, or example task available in Jazz.

Global options work here too: `jazz --debug` and `jazz --data-dir ~/work` open the same home. The
home needs a terminal to ask its questions. Without one (stdin or stdout piped, cron, CI), or with
`--no-tui`, it prints what to run instead and exits `2` without touching your configuration. On a
terminal that is too limited for the full-screen interface (`TERM=dumb`, `CI` set, a screen reader
via `JAZZ_A11Y=1` or `INK_SCREEN_READER=1`, or a window under 32 columns by 10 rows), Jazz uses the
classic inline interface, which prompts the same way.

---

## `jazz run`: headless, one-shot

The command every non-terminal integration is built on. Takes a dynamic prompt, runs one
agent turn, prints a clean payload. **stdout is the answer; all chatter goes to stderr.**

```bash
jazz run --agent <id> [prompt]
```

The prompt comes from the positional argument, from an `--input-stdin` frame, or from piped
stdin when neither is given and stdin is not a TTY. Only a positional or framed prompt may back a
memory write; plain piped stdin is treated as untrusted text.

Framed stdin preserves UTF-8 characters across arbitrary pipe chunk boundaries, including
incognito history. Bytes after the first newline remain available for interactive replies.

| Flag                           | Default      | Purpose                                                                                                                                                                |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`                 | **required** | Agent id or name                                                                                                                                                       |
| `--json`                       | off          | Emit one JSON envelope: `{ ok, answer, costUSD, tokenUsage, toolCalls }`                                                                                               |
| `--conversation <id>`          | none         | Stable conversation key. Loads prior history before the run, saves the transcript after, which gives stateless bridges per-chat memory                                 |
| `--approval-policy <p>`        | none         | `read-only` \| `low-risk` \| `high-risk`. Tools above the tier are **declined**                                                                                        |
| `--auto-approve-tools <names>` | none         | Comma-separated tool names allowed regardless of policy; narrower than raising the whole tier                                                                          |
| `--propose-goals`              | off          | Let the agent propose a goal for work that outlasts the run; the proposal waits for `jazz goal accept`                                                                 |
| `--timezone <iana-tz>`         | UTC          | Time zone used to resolve reminder times, such as `Europe/Paris`                                                                                                       |
| `--events <categories>`        | none         | NDJSON progress on stderr: `tools`, `reasoning`, `text`, `usage`, `approval`, `subagent`, `spend`, `all` (comma-separated)                                             |
| `--reasoning <effort>`         | agent config | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `disable`; a level the model does not accept runs at the nearest one it does, with a warning on stderr |
| `--timeout <ms>`               | none         | Abort the run after this many milliseconds (hard external kill, no warning): running commands are killed and the provider request is aborted                           |
| `--max-iterations <n>`         | 100          | Cap reasoning iterations                                                                                                                                               |
| `--max-cost-usd <$>`           | none         | Abort once cumulative spend (own + sub-agent) reaches this many dollars, checked between iterations                                                                    |
| `--max-tokens <n>`             | none         | Abort once cumulative prompt + completion tokens (own run only, not sub-agents) reach this count, checked between iterations: needs no model pricing                   |
| `--max-duration-ms <ms>`       | none         | Stop once elapsed wall-clock time reaches this budget, interrupting a model call or tool in flight, with agent pressure nudges at 50/80/90%                            |
| `--stream`                     | auto         | Force streaming. Required for `--events` in non-TTY contexts, where streaming auto-disables                                                                            |
| `--no-stream`                  | off          | Disable streaming                                                                                                                                                      |
| `--interactive-stdin`          | off          | Let a bridge relay questions and approvals as stdin/stdout events                                                                                                      |
| `--ephemeral`                  | off          | Do not load or save Jazz conversation/session history; withhold long-term memory writes                                                                                |
| `--input-stdin`                | off          | Read `{"prompt": ..., "history": [...]}` from the first stdin line, keeping a relayed message off argv. `history` needs `--ephemeral`                                  |
| `--park`                       | off          | Persist the run and exit `2` at an unanswered approval; resume it with `jazz runs approve`                                                                             |
| `--with-vision <p/m>`          | agent config | Bind an image-analysis companion for this run                                                                                                                          |
| `--with-audio <p/m>`           | agent config | Bind an audio-analysis companion for this run                                                                                                                          |
| `--with-video <p/m>`           | agent config | Bind a video-analysis companion for this run                                                                                                                           |

`--max-cost-usd` and `--max-tokens` are soft checkpoints, checked between iterations.
`--max-duration-ms` is a deadline: it interrupts the run wherever it is and still returns a
result. See [Configuration → run budgets](./configure/jazz.md#run-budgets)
for the enforcement model and how they differ from `--timeout`.

**Exit codes:** `0` on success; `1` on failure, including a run that finishes without a usable
answer (an empty zero-token completion, a non-`stop` finish with no text, or a content-filtered
answer); `2` when `--park` parks the run on an approval; `130` or `143` when SIGINT or SIGTERM
stops it. In plain mode stdout is empty on failure and the message goes to stderr; in `--json`
mode stdout always carries exactly one object, with a `code` on failures (`failed`,
`empty_response`, `no_answer`, `content_filtered`, `interrupted`). A cut-off answer
(`truncated`), an iteration limit (`iterationLimited`) and dropped tools (`toolsDisabled`) are
flagged in the envelope and warned about on stderr. See
[Headless → JSON](./surfaces/headless.md#json---json).

Full contract, examples, and a complete bridge implementation:
[Surfaces → Headless](./surfaces/headless.md).

---

## `jazz agent`

| Command                             | Purpose                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz agent list`                   | List all agents; `--can image\|audio\|video` filters to the ones that can generate that medium. `--json` prints one document. Agent files that cannot be read, or name an unknown provider or reasoning level, are reported on stderr (under `problems` in JSON) |
| `jazz agent create`                 | Create an agent (interactive)                                                                                                                                                                                                                                    |
| `jazz agent show <agentId>`         | Show an agent's details                                                                                                                                                                                                                                          |
| `jazz agent edit <agentId>`         | Edit an agent                                                                                                                                                                                                                                                    |
| `jazz agent delete <agentId>`       | Delete an agent. `-y, --yes` / `-f, --force` to skip confirmation                                                                                                                                                                                                |
| `jazz agent chat <agentIdentifier>` | Interactive session with a specific agent, by id or name. `--continue` picks up the agent's most recent saved conversation; add `--conversation <id>` for a specific one                                                                                         |

`agent chat` accepts `--stream` / `--no-stream`, `--max-iterations <n>`, and `--ephemeral`.

Without a terminal, `agent chat` reads messages from stdin, one per line, and ends when stdin does:

```bash
echo "What is on my calendar today?" | jazz agent chat assistant
```

Slash commands work the same way (`/exit` ends early). Tool calls that need approval are declined,
since nobody can answer the prompt. If stdin ends before any message arrives, `agent chat` says so
and exits `2`. For one scripted turn with a parseable result, use [`jazz run`](#jazz-run-headless-one-shot).

`agent create` and `agent edit` need a terminal. Without one they exit `2` and point at the agent's
JSON file under `$JAZZ_HOME/agents/`, which you can write by hand (see
[Configure → Agents](./configure/agents.md)). `persona create`, `persona edit`, and
`workflow create` behave the same way.

---

## `jazz workflow`

| Command                          | Purpose                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `jazz workflow create`           | Create a new workflow interactively                                                                                             |
| `jazz workflow list`             | List available workflows (global and local); `--json` prints one document                                                       |
| `jazz workflow show <name>`      | Show a workflow's prompt and metadata                                                                                           |
| `jazz workflow run <name>`       | Run once. See flags below                                                                                                       |
| `jazz workflow schedule <name>`  | Install a schedule: the workflow's own frequency, or `--cron "<expr>"` for another. `--as <label>` names it                     |
| `jazz workflow unschedule <id>`  | Remove a schedule by `<name>/<label>`, or by `<name>` to pick among its schedules                                               |
| `jazz workflow scheduled [name]` | List every installed schedule, or one workflow's                                                                                |
| `jazz workflow catchup`          | List workflows that missed a slot, select, run                                                                                  |
| `jazz workflow history [name]`   | Show run history                                                                                                                |
| `jazz workflow browse`           | Browse the library and install a workflow (interactive). `--refresh`                                                            |
| `jazz workflow search`           | List every workflow the library offers. `--refresh`                                                                             |
| `jazz workflow install <name>`   | Install a library workflow into `~/.jazz/workflows/`. `--as <name>` (local name), `-y`/`--yes` (skip confirmation), `--refresh` |

`install` prints the whole `WORKFLOW.md`, frontmatter included, and asks before writing it: the
frontmatter decides what the workflow may do unattended, so non-interactive runs must pass `--yes`.
The catalog is cached under `<jazz home>/cache/workflow-registry.json` and keeps working offline;
`JAZZ_LIBRARY_URL` points Jazz at a self-hosted library.

### `jazz workflow run` flags

| Flag                     | Purpose                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `--auto-approve`         | Run without the agent picker at the workflow's own `autoApprove:` policy (unset is `false`) |
| `--agent <agentId>`      | Override the agent for this run                                                             |
| `--max-iterations <n>`   | Override the workflow's iteration cap                                                       |
| `--max-cost-usd <$>`     | Override the workflow's spend cap                                                           |
| `--max-tokens <n>`       | Override the workflow's token cap                                                           |
| `--max-duration-ms <ms>` | Override the workflow's wall-clock budget (50/80/90% agent pressure nudges)                 |
| `--json`                 | One JSON envelope on stdout; all chatter suppressed                                         |
| `--timeout <ms>`         | Abort after this many milliseconds (hard external kill, no warning)                         |
| `--events <categories>`  | NDJSON progress on stderr. **Requires `--json`**: otherwise it errors                       |
| `--scheduled`            | Marks the run as scheduler-triggered (set automatically by launchd/cron)                    |
| `--schedule <id>`        | Which schedule fired, as `<name>/<label>` (set automatically by launchd/cron)               |

A workflow run that finishes without a usable answer (an empty zero-token completion, a
non-`stop` finish with no text, or a content-filtered answer) is recorded as failed in
`jazz workflow history` and exits `1`, with the same `code` in its `--json` envelope as
`jazz run`.

### Several schedules for one workflow

A workflow is a definition; a schedule binds it to a cron. `schedule <name>` installs
`<name>/default` from the frontmatter `schedule:` line. `schedule <name> --cron "0 9 1 * *" --as monthly`
adds `<name>/monthly` beside it, so the same recap runs weekly and monthly. Each schedule keeps its
own last-run marker, and the prompt can read `{schedule.label}`, `{schedule.cron}`,
`{schedule.lastRunAt}`, and `{run.startedAt}`. See [Workflows](./concepts/workflows.md#several-schedules-one-workflow).

Frontmatter fields: [Workflow frontmatter](./configure/workflows.md).

---

## `jazz mcp`

| Command               | Purpose                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jazz mcp add [json]` | Add a server from inline JSON, `--file <path>`, stdin, or by name with `--transport`, repeatable `--env`/`--header` (values go to the keyring), and optional `--trusted` |
| `jazz mcp list`       | List configured servers; `--tools` connects and discovers tools; `--json` prints one document without env values or headers                                              |
| `jazz mcp test`       | Connect to one server and report its tools and capabilities                                                                                                              |
| `jazz mcp auth`       | Complete OAuth 2.1 authorization for a remote server                                                                                                                     |
| `jazz mcp logout`     | Remove a remote server's stored OAuth credentials                                                                                                                        |
| `jazz mcp trust`      | Honor the read-only annotations of a server defined in `~/.agents/mcp.json` when applying approval policy                                                                |
| `jazz mcp untrust`    | Require approval for every tool from the server                                                                                                                          |
| `jazz mcp remove`     | Remove a server                                                                                                                                                          |
| `jazz mcp enable`     | Enable a disabled server                                                                                                                                                 |
| `jazz mcp disable`    | Disable a server                                                                                                                                                         |

See [MCP configuration](./configure/mcp.md).

---

## `jazz hosts`

| Command                                               | Purpose                                     |
| ----------------------------------------------------- | ------------------------------------------- |
| `jazz hosts list`                                     | List registered SSH servers                 |
| `jazz hosts add <name> <ssh-target> <workspace-path>` | Register a server and existing workspace    |
| `jazz hosts remove <name>`                            | Remove the local host registration          |
| `jazz hosts doctor <name>`                            | Check SSH, disk, platform, Jazz, and daemon |

To set up a server and move a conversation step by step, see
[Continue on your server](./features/detach.md).

The SSH target is a configured SSH alias. The remote workspace must exist and be writable.
Pass `--allow-file-secrets` to `hosts add` for a server without an OS keyring (libsecret);
without it, a handoff to such a server stops before anything moves.
See [Detach hosts](./security/detach-hosts.md) for the host checks and credential scope.

## `jazz detach`

| Command                                         | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `jazz detach list`                              | List conversations moved to a server, newest first               |
| `jazz detach attach <handoffId>`                | Watch a remote conversation live, reply, and answer approvals    |
| `jazz detach status <handoffId>`                | Read the remote state of a detached conversation                 |
| `jazz detach approve <handoffId>`               | Approve the tool call on which a detached run has parked         |
| `jazz detach reject <handoffId>`                | Reject that tool call and let the detached run continue          |
| `jazz detach cancel <handoffId>`                | Stop the remote run's current or queued turn                     |
| `jazz detach reclaim <handoffId> [--overwrite]` | Bring the conversation and its file changes back to this machine |
| `jazz detach pull <handoffId>`                  | Download remote file changes to a local staging directory        |

`unknown` means the host could not be reached; it does not mean the remote run stopped.
For a parked tool approval, `status` shows the tool and its approval message before
offering `approve` or `reject`. Other interactive input is reported as unsupported
in this version.
`attach` replays everything the remote run has done so far, then follows it live. When a
turn finishes it prompts for your next message; when the run parks it asks to approve or
reject. An empty answer or Ctrl+C leaves; the remote run keeps going, and attaching again
picks up where you left off.

`reclaim` freezes the remote job so the host never runs it again, downloads its final state,
applies the remote file changes to your working tree, and restores the conversation locally
with the remote turns included. Continue it with `/resume` in chat. If a file changed both
locally and remotely, nothing is written: commit or stash your edits and rerun, or pass
`--overwrite` to let the remote version win. A reclaim that fails part way leaves the
conversation fenced; rerunning it continues where it stopped.

`pull` downloads and verifies the completed result, then lists changed paths and conflicts
with local changes, without touching the working tree.

In interactive chat, `/detach <host>` asks for a continuation instruction, previews the
files and state to transfer, and asks for confirmation. When entered while the agent is
busy, it runs after the current turn. A failure before remote ownership leaves the local
chat available. Once transfer begins, the local chat closes if the remote run acknowledges
the handoff or ownership cannot be resolved safely. Register and check hosts with
`jazz hosts` first.

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
With a [notify target](configure/notifications.md) the approval request reaches your phone, and
a Telegram or Discord bridge can answer it with `/approve <runId>`.

---

## `jazz spend`

What every run on this machine cost today and this month, from the machine-wide ledger under
`$JAZZ_HOME/spend`, with a breakdown by source (chat, workflows, goals, loops, bots, ...) and by
agent, what unattended runs spent today, and where each `daemon` spend cap stands. `--json`
emits `{ ok, day, month, today, thisMonth, caps, unreadableLines }`. See
[Budgets](concepts/budgets.md#daily-and-monthly-caps).

---

## `jazz notify`

Where results, reminders, parked approvals, failures and pauses reach you while you are away:
the `notify.targets` list. See [Notifications](configure/notifications.md).

| Command                   | Purpose                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz notify list`        | List the targets (one desktop target while `notify.targets` is unset). `--json`                                                                                                             |
| `jazz notify add <name>`  | Add or replace a target: `--kind desktop\|ntfy\|webhook\|telegram\|discord`, `--url`, `--chat-id`, `--channel-id`, `--api-base-url`, `--events`, `--approve-from-chat`. Asks for its secret |
| `jazz notify test <name>` | Send a test through one target and report what it answered. `--json`                                                                                                                        |
| `jazz notify outbox`      | Show notifications still waiting, with the last error and next retry. `--json`                                                                                                              |
| `jazz notify retry`       | Re-arm notifications that stopped retrying and deliver the outbox now. `--json`                                                                                                             |

---

## `jazz daemon`

Serves runs over HTTP: start one, poll it, approve or reject what a parked one is waiting for
, from a different terminal, a different process, or a different machine than the one that
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

A request that grants authority (accepting or resuming a goal, starting or resuming a loop,
approving or answering a parked run, and any write to an agent or persona) also needs the operator token in `X-Jazz-Operator-Token`. It lives only in
the OS keyring, so an agent that read the daemon token from disk cannot use it to grant itself
more. Without one the daemon grants nothing over HTTP, and the CLI on the machine decides instead.
See [Daemon](./concepts/daemon.md#granting-authority-over-http).

| Command                             | Purpose                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz daemon set-token`             | Generate (or store `$JAZZ_DAEMON_TOKEN` if set) a token before the daemon's first run: useful when a client needs the value in advance                                                                                                                                                                         |
| `jazz daemon forget-token`          | Remove the stored token                                                                                                                                                                                                                                                                                        |
| `jazz daemon operator-token`        | Generate the operator token that HTTP grants need (accept a goal, start or resume a loop, approve or answer a run), store it in the OS keyring only, and print it once. Refused inside a process a Jazz agent started                                                                                          |
| `jazz daemon forget-operator-token` | Remove the operator token, so the daemon grants nothing over HTTP                                                                                                                                                                                                                                              |
| `jazz daemon stop`                  | Stop the background daemon listening on this port                                                                                                                                                                                                                                                              |
| `jazz daemon status`                | Whether this home’s daemon is running and supervised, its last tick and pending work, pause state, today’s spend against the daily caps, and everything waiting for you. `--json`; exits 1 when not running                                                                                                    |
| `jazz daemon logs`                  | Print recent daemon output; `-n, --lines <n>` and `-f, --follow`                                                                                                                                                                                                                                               |
| `jazz daemon pause`                 | Stop background work from starting: goal cycles, loop runs, triggers, and new HTTP runs. Running work finishes and waiting items can still be answered                                                                                                                                                         |
| `jazz daemon resume`                | Start background work again; when a machine daily cap is reached, lift it for the rest of the day. Refused inside a process a Jazz agent started, and over HTTP it needs the operator token                                                                                                                    |
| `jazz daemon install`               | Install this as a persistent system service (systemd/launchd). Needs root; generates and stores its own token if none is set (no keyring or `$JAZZ_DAEMON_TOKEN` needed); doesn't report success until `/health` answers; `--serve-peers <agentId>` (optional: also answer peers), `--host`, `--port`, `--yes` |
| `jazz daemon uninstall`             | Remove the service installed by `install`. Needs root; `--yes`                                                                                                                                                                                                                                                 |

Set `$JAZZ_DAEMON_TOKEN` yourself instead of letting Jazz generate one when the value needs to
be known ahead of time: a client config written before the daemon has ever run, or an
ephemeral container whose `$JAZZ_HOME` doesn't survive to the next deploy.

See [Setting up peers](./guides/connect-peers.md) for a full walkthrough, and
[Agent-to-agent](./concepts/agent-to-agent.md) for the tier model this exists to serve.

A background daemon writes its output to `$JAZZ_HOME/logs/daemon.log`. Without an installed
service, nothing restarts it after a reboot; `jazz goal` and `jazz loop` say so when they hand it
work. See [Running it persistently](./concepts/daemon.md#running-it-persistently).

`jazz wake-trigger fire --agent <agentId> --id <id>` is internal plumbing, not something you run
by hand: it's what `register_trigger` schedules with `launchd`/`at` to fire a wake trigger without
`jazz daemon` running. See [Wake Triggers](./tools/index.md#wake-triggers). `jazz reminder fire`
and `jazz job run` are the same kind of plumbing for reminders and job batches.

---

## `jazz reminders`, `jazz triggers`, `jazz jobs`

What agents have scheduled to happen later, across every agent unless `--agent <id-or-name>`
narrows it.

| Command                      | Purpose                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `jazz reminders list`        | Reminders set with `remind_me`, soonest first. `--agent`, `--json`                         |
| `jazz reminders cancel <id>` | Cancel one, and its host scheduler job. `--agent`                                          |
| `jazz triggers list`         | Wake triggers that will resume a conversation, soonest first. `--agent`, `--json`          |
| `jazz triggers cancel <id>`  | Cancel one, and its host scheduler job. `--agent`                                          |
| `jazz jobs list`             | Background job batches still active, with each batch's jobs by status. `--agent`, `--json` |
| `jazz jobs cancel <id>`      | Cancel a batch's jobs that have not started; running jobs finish. `--agent`                |

`--json` prints one envelope: `{"ok":true,"reminders":[…]}`, `{"ok":true,"triggers":[…]}`, or
`{"ok":true,"batches":[…]}`.

---

## `jazz goal`

Goals are objectives Jazz keeps working toward across runs until verified evidence shows they
are done. Each goal has a short name, like `detach-to-prod`, that every command accepts in place
of its id. In chat, a goal you accept runs in the chat, asking its approvals there; see
[Goals in chat](#goals-in-chat). From a shell, the daemon does the work: accepting or starting a
goal launches `jazz daemon` in the background when none is serving this Jazz home.

```bash
jazz goal draft --agent assistant "Get every recipe into the new format until ./check.sh passes"
jazz goal start --agent assistant --yes --max-cycles 20 "…"
jazz goal list
jazz goal show <goal>
jazz goal accept <goal> --approval-policy low-risk   # start a proposed goal; work begins now
jazz goal decline <goal>
jazz goal approve <goal>             # allow the step it waits on
jazz goal reject <goal> [why]        # refuse that step; the reason goes to the agent
jazz goal answer <goal> <answer>     # answer its question
jazz goal pause <goal>
jazz goal resume <goal> [note]       # the note steers the next cycle
jazz goal cancel <goal>
```

`--approval-policy` on `accept` and `start` is what the goal may run while you are away without
asking: `read-only`, `low-risk`, or `high-risk` (everything). Above it, a cycle waits for your
approval. Without the flag nothing runs unasked, so every gated call waits for you. `approve`, `reject`, and `answer` run the rest of that cycle in the shell; the
daemon carries on after. A Jazz agent cannot approve or answer a parked run itself.

`draft` prints the plan, or the questions it needs answered first, without creating anything.
`start` drafts and, with `--yes`, starts the plan; without `--yes` it only shows it.
`--max-cycles` caps the cycles (no limit by default). Each cycle is an ordinary run, held to the agent loop's own
limits (`maxIterations`, `maxTokens`, `maxCostUSD`, `maxDurationMs` in config); the goal adds
no spend cap of its own.
A read-only pass over the current directory informs the plan, as it would in chat; `--no-inspect`
drafts from the request alone. With `--json` each command prints one JSON envelope.
Exit codes: `0` done, `1` refused or failed, `2` the request needs answers before a plan.

### Goals in chat

`/goal <objective>` starts working toward the objective right away, in the same conversation.
Nothing is drafted or confirmed first, and the turns look like any other: the same streaming,
approvals under the chat's safe or yolo mode, and questions asked inline. When a turn ends, the
next one starts on its own, with a `↻ Goal <name> · turn n` line, until the agent reports
the goal done. A done report is accepted only when it quotes the tool output that shows the
objective holds; otherwise the goal goes on with the reason. If it stops for you (a question,
a blocker), the chat asks right there and carries on with your answer.

Esc pauses the goal. Anything you type meanwhile goes first and the goal picks up after it.
`/goal` shows where it stands, `/goal pause`, `/goal resume [note]`, and `/goal clear` control
it, and `/goal help` lists the rest, including `approve`, `reject`, and `answer` for a goal left
waiting in the background. A conversation has one goal at a time; setting another offers to
drop the current one.

Leaving a chat with a goal unfinished asks whether Jazz should finish it in the background, and
what it may do there without asking: reading only, low-risk changes, or everything. It carries
on in the same conversation, and anything above that authority waits for you. The next `jazz`
then lists the conversation first under **Resume conversation (N waiting for you)**, marked
with what it waits on.

## `jazz loop`

A loop reruns a prompt for an agent on a schedule, on one conversation of its own, until it ends:
"every 10 minutes, check whether the deploy finished and tell me". Each loop has a short name,
taken from `--name` or the start of its prompt, that every command accepts in place of its id.
Loops run in the daemon, never in the terminal that started them: starting or resuming one
launches `jazz daemon` in the background when none is serving this Jazz home.

```bash
jazz loop start --agent assistant --every 10m "Check whether the deploy finished and tell me"
jazz loop start --agent assistant --every "0 9 * * mon-fri" --until 2026-10-31 --name standup "Summarize yesterday's PRs"
jazz loop list
jazz loop show <loop>
jazz loop approve <loop>             # allow the step its run waits on
jazz loop reject <loop> [why]        # refuse that step; the reason goes to the agent
jazz loop answer <loop> <answer>     # answer its run's question
jazz loop pause <loop>
jazz loop resume <loop>              # a budget-limited loop gets one more default budget
jazz loop cancel <loop>
```

`--every` takes a duration (`10m`, `1h30m`, at least a minute) or a five-field cron expression,
read in `--tz` (default: this machine's timezone). An interval loop runs right away; a cron loop
waits for its first scheduled time. Runs missed while the daemon was down collapse into one, and a
loop never overlaps itself, including while a run waits for an approval.

A loop ends when its run calls `end_loop` (it gets that tool, and only loop runs do), when it
reaches `--max-runs` or `--until`, or when you cancel it. Three failed runs in a row stop it
for you to look at; `resume` starts it again. Budget flags cover all runs together:
`--max-tokens`, `--max-minutes`, and `--max-cost-usd` (enforced when pricing is known), and
each run is held to the agent loop's own limits like any run. A loop that hits one of its
budgets is budget-limited until you resume it.

`--approval-policy` is what its runs may do without asking: `read-only`, `low-risk`, or
`high-risk` (everything). Above it, the run waits; `approve`, `reject`, and `answer` finish that
run in the shell, under what the loop's budget has left. Pausing or canceling a loop whose run is
waiting drops that run. A Jazz agent cannot start, resume, approve, or answer a loop. With
`--json` each command prints one JSON envelope. Exit codes: `0` done, `1` refused or failed.

### Loops in chat

`/loop 10m <prompt>` (or `/loop every 10m <prompt>`, or `/loop cron 0 9 * * mon-fri <prompt>`)
starts a loop for the chat's agent in its current directory, after asking what its runs may do
without asking. `/loop help` lists the commands; they mirror `jazz loop`. Opening a conversation
shows its loops that wait for you, and the next `jazz` counts them under **Resume conversation**.

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
[Reaching your agent from a chat app](./guides/deploy-a-chat-agent.md#imessage-through-your-own-mac) for changing it
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
, or by editing `~/.jazz/config.json` directly. See [Setting up peers](./guides/connect-peers.md)
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

| Command                            | Purpose                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jazz persona list`                | List personas (built-in + custom); `--json` prints one document                                      |
| `jazz persona create`              | Create a custom persona (interactive)                                                                |
| `jazz persona show <identifier>`   | Show a persona by name or id                                                                         |
| `jazz persona edit <identifier>`   | Edit a custom persona                                                                                |
| `jazz persona delete <identifier>` | Delete a custom persona                                                                              |
| `jazz persona browse`              | Browse the library and install a persona (interactive). `--refresh`                                  |
| `jazz persona search`              | List every persona the library offers. `--refresh`                                                   |
| `jazz persona install <name>`      | Install a library persona. `--as <name>` (local name), `-y`/`--yes` (skip confirmation), `--refresh` |

`install` prints the full system prompt and asks before writing it: a persona becomes an agent's
instructions, so non-interactive runs must pass `--yes`. The catalog is cached under
`<jazz home>/cache/persona-registry.json` and keeps working offline; `JAZZ_LIBRARY_URL`
points Jazz at a self-hosted library.

See [Personas](./concepts/personas.md).

---

## `jazz skill`

| Command                     | Purpose                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `jazz skill list`           | List the skills agents can load, by source; `--json` prints one document                              |
| `jazz skill browse`         | Browse the reviewed skill marketplace and install a skill (interactive). `--refresh`                  |
| `jazz skill search [query]` | Search marketplace skill names, descriptions, tags, and metadata. `--refresh`                         |
| `jazz skill install <name>` | Install one reviewed `SKILL.md` into `~/.jazz/skills/`. `-y`/`--yes` (skip confirmation), `--refresh` |

Marketplace skills are instruction-only. Installation prints the complete file, asks for
confirmation, writes only `SKILL.md`, and never executes or imports the downloaded text. Non-
interactive installs must pass `--yes`. The catalog is cached under
`<jazz home>/cache/skill-registry.json`, works offline after a successful fetch, and uses
`JAZZ_LIBRARY_URL` when you host a compatible library yourself.

Skills can influence an agent's behavior but grant no tools, credentials, network access, or
approval authority. Read the source for prompt injection or unsafe guidance before installing.
See [Skills](./concepts/skills.md).

---

## `jazz plugin`

Every command below that takes `<id>` also accepts the `owner/repo` (or GitHub URL) you installed
from — it resolves to the installed plugin. Trust and enable prompt for a plain yes/no confirmation.

| Command                                           | Purpose                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jazz plugin init <directory>`                    | Scaffold a types-only SDK plugin project. `--id`, `--name`                                                                                                                                                          |
| `jazz plugin dev [directory]`                     | Pack and audit in a disposable host. `--hook route.skills --input <json>`                                                                                                                                           |
| `jazz plugin pack [directory]`                    | Emit `plugin.mjs`, its SHA-256, and `catalog-entry.json`                                                                                                                                                            |
| `jazz plugin add <owner/repo\|source\|id>`        | Install from a GitHub `owner/repo` (default, `@ref` to pin), a local source dir, a manifest, or a catalog id; does not trust or enable                                                                              |
| `jazz plugin inspect <id>`                        | Show exact digest, declarations, grants, enablement, and secret status. `--json`                                                                                                                                    |
| `jazz plugin trust <id>`                          | Locally acknowledge full OS-user code execution for the current digest                                                                                                                                              |
| `jazz plugin enable <id> [--agent <id-or-name>]`  | Grant current egress consent and enable for one agent, or for all agents when `--agent` is omitted                                                                                                                  |
| `jazz plugin disable <id> [--agent <id-or-name>]` | Prevent new dispatches for one agent or all agents                                                                                                                                                                  |
| `jazz plugin update <id> [source]`                | Re-fetch and install an update, retaining one rollback artifact and disabling pending grants. Omitting `source` re-pulls the recorded source, so `jazz plugin update owner/repo` re-fetches a GitHub source install |
| `jazz plugin rollback <id>`                       | Swap current/previous artifacts and disable pending grants                                                                                                                                                          |
| `jazz plugin doctor <id>`                         | Check artifact, grants, declarations, and required secrets. `--json`                                                                                                                                                |
| `jazz plugin remove <id>`                         | Remove state/artifacts and Jazz-owned secrets. `--keep-secrets`                                                                                                                                                     |
| `jazz plugin list`                                | List installed plugin state                                                                                                                                                                                         |
| `jazz plugin gc`                                  | Remove unreferenced, unloaded artifacts                                                                                                                                                                             |
| `jazz plugin secret set <id> <name>`              | Store a declared plugin-scoped credential                                                                                                                                                                           |
| `jazz plugin secret status <id> <name>`           | Report whether a credential comes from environment, keyring, file, or is missing                                                                                                                                    |
| `jazz plugin secret forget <id> <name>`           | Delete a Jazz-owned plugin credential; environment values are unaffected                                                                                                                                            |

Trust and consent require a local interactive terminal. This includes explicit consent for a
`classify.command-risk` policy hook: it may send bounded command text to its declared destination
and its validated verdict can affect whether an eligible `execute_command` call needs approval.
Static tool risks, allowlists, approval tiers, and the shell denylist remain enforced by Jazz. See
[Plugins](./configure/plugins.md).

---

## `jazz config`

| Command                         | Purpose                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `jazz config show`              | Show all configuration values, secrets redacted; `--reveal` prints them                                           |
| `jazz config validate`          | Check config files without starting the application                                                               |
| `jazz config get <key>`         | Print one value and nothing else, redacted when it is or holds a secret; `--reveal` prints it. Exits `1` if unset |
| `jazz config set <key> [value]` | Set one value                                                                                                     |

`config validate` also checks every agent file: one that cannot be read, or names a provider or
reasoning level Jazz does not know, fails the check with exit code `1`; a tool name no built-in
provides is a warning, since an MCP server, plugin, or custom tool may supply it. `config set`
refuses a key Jazz does not read, including an API key for a provider that does not exist
(`llm.opneai.api_key`), and trims pasted keys. `jazz config set <provider>` with no value prompts
for the key, so it never lands in your shell history, and checks it with the provider where
there is a free endpoint to ask.

See [Configuration](./configure/jazz.md).

---

## `jazz memory`

| Command                              | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `jazz memory list <agent>`           | List durable memory files available to an agent               |
| `jazz memory show <agent> <path>`    | Print one memory file as the agent reads it                   |
| `jazz memory forget <agent> <path>`  | Permanently delete one memory file                            |
| `jazz memory explain <agent> <path>` | Show provenance and recent opportunity receipts for one entry |
| `jazz memory recall`                 | Report memory consultation; `--surface <name>` filters it     |

Conversation history and current working state are separate. See [Conversations, working state, and memory](./concepts/conversations-and-memory.md).

---

## `jazz webhook`

| Command                             | Purpose                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `jazz webhook token <name>`         | Generate and store a bearer token; print it once                                     |
| `jazz webhook forget-token <name>`  | Remove a webhook's stored token                                                      |
| `jazz webhook secret <name>`        | Generate and store the secret its sender signs bodies with (GitHub's webhook secret) |
| `jazz webhook forget-secret <name>` | Remove a webhook's stored signing secret                                             |

Webhook definitions live in Jazz configuration. See [Webhooks](./concepts/webhooks.md).

---

## `jazz update`

| Command               | Purpose                              |
| --------------------- | ------------------------------------ |
| `jazz update`         | Update Jazz to the latest version    |
| `jazz update --check` | Check for updates without installing |

Both exit 1 when the version check or the install fails, so a script can tell a failed update
from "already up to date".

---

## In-chat commands

Available inside an interactive session. `/help` lists them, then your skills, MCP prompts, and
plugin commands in their own sections, then the keys of the interface you are in. `/help <command>`
shows every form of one command. The table below is generated from the same list
(`bun run docs:chat-commands`).

<!-- chat-commands:start -->

| Command                                                                              | Purpose                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/agents`                                                                            | List all available agents.                                                                                    |
| `/peers`                                                                             | List configured peers and what each may learn or do.                                                          |
| `/clear`                                                                             | Clear the screen.                                                                                             |
| `/compact`                                                                           | Summarize older history now, keeping recent messages.                                                         |
| `/config [tools]`                                                                    | Show the agent's configuration ('/config tools' toggles its tools).                                           |
| `/context`                                                                           | Show context window usage and token breakdown.                                                                |
| `/work [clear]`                                                                      | Show saved task state and compaction records ('/work clear' discards them).                                   |
| `/copy`                                                                              | Copy the last agent response to clipboard.                                                                    |
| `/cost`                                                                              | Show conversation token usage and estimated cost, including sub-agents.                                       |
| `/exit`                                                                              | Exit the chat. Also `/quit`.                                                                                  |
| `/export [path]`                                                                     | Export the conversation to a markdown file.                                                                   |
| `/fork`                                                                              | Fork conversation into a new branch (keeps full history).                                                     |
| `/detach <host>`                                                                     | Continue this conversation on a registered SSH host after this turn.                                          |
| `/goal [objective\|pause\|resume\|clear\|list\|accept\|decline]`                     | Keep working toward an objective, turn after turn, in this conversation. See [Goals in chat](#goals-in-chat). |
| `/help [command]`                                                                    | Show available commands and shortcuts.                                                                        |
| `/loop <every> <prompt>\|cron\|list\|approve\|reject\|answer\|pause\|resume\|cancel` | Rerun a prompt on a schedule in the background. See [Loops in chat](#loops-in-chat).                          |
| `/memory [forget <path>]`                                                            | Show what this agent has remembered about you, or forget one file.                                            |
| `/limit [turns\|usd\|tokens <value>\|clear]`                                         | Set a session turn, cost, or token limit (applied immediately).                                               |
| `/mcp [reconnect <server>]`                                                          | Show MCP servers, or reconnect one.                                                                           |
| `/mode [allow\|disallow <cmd>]`                                                      | Switch between safe mode and yolo mode for tool approvals (also Shift+Tab).                                   |
| `/model [model]`                                                                     | Change the agent's model for this session only. Also `/models`.                                               |
| `/reasoning [minimal\|low\|medium\|high\|xhigh\|max\|disable]`                       | Change reasoning for this session only.                                                                       |
| `/resume`                                                                            | Browse and resume a past conversation.                                                                        |
| `/retry`                                                                             | Re-send your last message.                                                                                    |
| `/new`                                                                               | Start a new conversation (clear context).                                                                     |
| `/skills`                                                                            | Search installed skills by name, source, or description.                                                      |
| `/info`                                                                              | Show conversation id, title, usage, and log file paths for this session. Also `/stats`.                       |
| `/switch [agent]`                                                                    | Switch to a different agent in the same conversation.                                                         |
| `/theme light\|dark`                                                                 | Switch between light and dark theme.                                                                          |
| `/tools`                                                                             | List all agent tools by category.                                                                             |
| `/workflows [action]`                                                                | List workflows, or send an action (e.g. create) to the agent.                                                 |
| `! <command>`                                                                        | Run a shell command and give its output to the agent. See [Shell escapes](#shell-escapes).                    |

<!-- chat-commands:end -->

Only `/exit` (or `/quit`) ends the chat; `exit` or `quit` typed alone is sent to the agent as a
message. A message that starts with a file path, which is what dragging a file into the terminal
inserts (`/Users/me/shot.png what is this?`), is sent to the agent rather than read as a command.
An unknown command stays in the composer so you can fix it, and Jazz suggests the closest command.

`/model` changes the model for the rest of this session on the agent's own provider: `/model`
opens a picker, `/model <model-id>` sets it directly. The agent file keeps its model; use
`jazz agent edit` to change that for good. `/reasoning` works the same way for the reasoning level.

### Mentioning files with `@`

Type `@` to pick a file or folder under the current directory. A picked path with spaces is
quoted for you (`@"my notes.md"`). When you send the message:

- An image, PDF, audio, or video file is attached, if the model accepts that kind of input.
- A text file of up to 256 KiB is read and sent along with your message, so the agent sees its
  contents.
- Anything else (a folder, a binary file, a larger file) is sent as its path only. Jazz says so for
  a binary or oversized file; the agent can still open it with its file tools.

### Keyboard shortcuts

The fullscreen interface is the default on a capable terminal. The classic inline interface runs
with `JAZZ_FULLSCREEN=0`, and on terminals the fullscreen one cannot use. The two bind different
keys. In both, interrupting work takes a double Esc or one Ctrl+C.

**Fullscreen:**

<!-- keys-fullscreen:start -->

| Keys                                   | Action                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Enter                                  | Send the message                                                                                  |
| Shift+Enter                            | Insert a newline for a multi-line message                                                         |
| Tab                                    | Complete the highlighted slash command or @ path                                                  |
| Up/Down (empty input)                  | Recall previously sent messages                                                                   |
| Ctrl+A / Ctrl+E                        | Move to the start or end of the line                                                              |
| Ctrl+U                                 | Delete from the caret to the start of the line                                                    |
| Option+Enter                           | Insert a newline for a multi-line message                                                         |
| Ctrl+V                                 | Paste from the clipboard                                                                          |
| Ctrl+Z / Ctrl+Shift+Z                  | Undo or redo an edit in the composer                                                              |
| Cmd+A                                  | Select the whole draft                                                                            |
| Esc                                    | Close the open dialog, search, or menu; otherwise clear the draft; otherwise focus the transcript |
| Esc Esc (agent busy)                   | Interrupt the current generation or tool                                                          |
| Esc Esc (agent busy, messages queued)  | Interrupt and send the queued messages now                                                        |
| Ctrl+C (agent busy)                    | Interrupt the current generation or tool                                                          |
| Ctrl+C Ctrl+C                          | Leave the conversation                                                                            |
| Shift+Tab                              | Toggle safe/yolo approval mode                                                                    |
| Ctrl+R                                 | Expand collapsed reasoning (repeat for earlier blocks)                                            |
| Ctrl+O                                 | Expand the last truncated diff or tool output                                                     |
| Up (agent busy)                        | Recall queued messages for editing                                                                |
| Ctrl+X (agent busy, empty input)       | Clear the message queue                                                                           |
| Ctrl+B (tool running)                  | Move the running tool call to the background                                                      |
| Down (sub-agents listed)               | Pick a sub-agent under the input; Enter opens its log                                             |
| Enter (sub-agent open)                 | Send the draft to that sub-agent instead of the main chat                                         |
| Esc (sub-agent open)                   | Return to the main conversation                                                                   |
| Ctrl+F                                 | Search the conversation                                                                           |
| PgUp/PgDn                              | Scroll the conversation                                                                           |
| Up/Down, Home/End (transcript focused) | Scroll line by line or to either end; type to return to the input                                 |

<!-- keys-fullscreen:end -->

**Classic:**

<!-- keys-classic:start -->

| Keys                             | Action                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| Enter                            | Send the message                                                   |
| Shift+Enter                      | Insert a newline for a multi-line message                          |
| Tab                              | Complete the highlighted slash command or @ path                   |
| Up/Down (empty input)            | Recall previously sent messages                                    |
| Ctrl+A / Ctrl+E                  | Move to the start or end of the line                               |
| Ctrl+U                           | Delete from the caret to the start of the line                     |
| Ctrl+K                           | Delete from the caret to the end of the line                       |
| Ctrl+W                           | Delete the word before the caret                                   |
| Esc                              | Clear the current draft                                            |
| Esc Esc (agent busy)             | Interrupt the current generation or tool, and drop queued messages |
| Ctrl+C (agent busy)              | Interrupt the current generation or tool                           |
| Ctrl+C Ctrl+C                    | Leave the conversation                                             |
| Shift+Tab                        | Toggle safe/yolo approval mode                                     |
| Ctrl+R                           | Expand collapsed reasoning (repeat for earlier blocks)             |
| Ctrl+O                           | Expand the last truncated diff or tool output                      |
| Up (agent busy)                  | Recall queued messages for editing                                 |
| Ctrl+X (agent busy, empty input) | Clear the message queue                                            |

<!-- keys-classic:end -->

### Watching and steering sub-agents

When the agent delegates with `spawn_subagent`, the turn's sub-agents are listed under the
composer with what each one is doing right now. With the composer empty, press Down to
move into the list, Up and Down to pick one, and Enter to open it: the transcript is
replaced by that sub-agent's brief, reasoning, tool calls, and answer, and keeps updating
while it works. Esc returns to the main conversation.

While a sub-agent is open, Enter sends your draft to it instead of to the main chat. The
sub-agent reads it between tool calls, the same point where the main agent picks up
queued messages, and treats it as guidance on its current task. If it finishes before
reaching another tool call, Jazz says the message was not delivered. Finished sub-agents
stay in the list until your next message. Companions started by `analyze_media` and
`generate_media` are listed too, but take no messages: each makes a single model call with
no tool calls to pause between.

With `output.streaming.enabled: false`, completed model responses and tool calls still appear
in the sub-agent's detail log. A message queued during the final tool batch stays marked
undelivered when the child reaches its iteration or run budget before another model call.

### Shell escapes

In the interactive terminal, type `! <command>` when the agent asks you to run a command
yourself. Jazz executes the command in the current session directory and sends its bounded
stdout, stderr, and exit code to the agent as context for the next response:

```text
> ! ssh user@test rm -r folder
> Did that remove the folder successfully?
```

The `!` must be followed by a space (or tab). A message such as `!!! call the bank today` or
`!important` is prose and goes to the agent. In the fullscreen interface, typing `!` on an empty
line inserts the `!` and a space for you; typing a second `!` straight away takes the space
back.

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
| `hybrid`   | Default: rendered with plain fallbacks     |
| `raw`      | No formatting, no ANSI. **Use this in CI** |
| `quiet`    | Suppress output                            |

Set `NO_COLOR` to any non-empty value (see [no-color.org](https://no-color.org)) to turn colour off
everywhere: the classic interface and plain output print no colour codes at all, and the
fullscreen interface paints in its neutral greys, keeping bold and dim for emphasis.

---

## Related

- [Surfaces → Headless](./surfaces/headless.md): the `jazz run` contract in depth
- [Configuration](./configure/jazz.md): config file and environment variables
- [Tools](./tools/index.md): every tool and its risk tier
- [Workflow frontmatter](./configure/workflows.md): the `WORKFLOW.md` fields
