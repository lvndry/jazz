---
description: "Run the Jazz daemon for background goals and loops, HTTP requests, webhooks, and peers. Install it as a service and manage authentication and spend limits."
---

# Daemon

Run `jazz daemon` to accept HTTP requests, continue background goals and loops, and receive
webhooks or peer questions. For recurring workflows, it can also replace the OS scheduler.

## Start the daemon

```bash
jazz daemon
jazz daemon status
```

The daemon starts in the background. On first start it generates an authentication token
and prints it once; keep that value if you want to call it over HTTP. You can use the CLI
without copying it:

```bash
jazz runs list
jazz runs show <run-id>
jazz runs approve <run-id>
jazz runs reject <run-id>
```

## Start a run over HTTP

[Create an agent](../getting-started/create-an-agent.md) named `assistant` first. In the
client's shell, set `JAZZ_DAEMON_TOKEN` to the token printed when you started the daemon:

```bash
export JAZZ_DAEMON_TOKEN='<your-daemon-token>'
curl -X POST http://localhost:4747/runs \
  -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"assistant","prompt":"Summarize the project files without changing them"}'
```

The response identifies the run. Replace `<run-id>` below with that ID to read its status:

```bash
curl http://localhost:4747/runs/<run-id> \
  -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN"
```

If it waits for approval, use `jazz runs approve <run-id>` on the host. To approve over HTTP,
configure an [operator token](#granting-authority-over-http) as well.

---

## Available services

- **Serves runs over HTTP.** `POST /runs` starts one, `GET /runs/:id` polls it,
  `POST /runs/:id/answer` approves or rejects a parked action, and `GET /runs` lists active runs.
- **Owns accepted goals.** `POST /goals` creates a proposed goal, and versioned `POST /goals/:id/{accept,pause,resume,cancel}` routes control its lifecycle. `GET /goals` and `GET /goals/:id` read state. The daemon claims and advances goal cycles; if it is stopped, goals remain saved and wait for it to return.
- **Runs loops.** `POST /loops` starts one (`agentId`, `prompt`, `every`, absolute `workingDirectory`, optional `timezone`, `name`, `approvalPolicy`, `maxRuns`), and versioned `POST /loops/:loop/{pause,resume,cancel}` routes control it. `GET /loops` and `GET /loops/:loop` read state. Each tick starts the loops that are due; if the daemon is stopped, loops wait and their missed runs collapse into one.
- **Serves the agent catalogue.** `GET`/`POST`/`DELETE` on `/agents`, `/personas`, plus
  `/catalog`, `/models` and `/tools`. Writes need the
  [operator token](#granting-authority-over-http).
- **Owns the schedule ticker**, when `scheduler.mode` is `in-process`. Schedules normally ride the
  OS scheduler, which only fires while the machine is awake. The daemon's ticker is the
  alternative on a host you leave running. See [Scheduled runs](../surfaces/scheduled.md).
- **Answers peers**, when started with `--serve-peers <agentId>`. `POST /peer/ask` and `POST
/a2a` need a running daemon to have anyone to ask. Without one your agent can still ask
  _other_ peers, but nobody can ask yours. See [Agent-to-agent](./agent-to-agent.md).
- **Serves webhooks.** `POST /webhooks/<name>` wakes the agent that webhook names. See
  [Webhooks](./webhooks.md).

Webhook and peer requests have per-endpoint budgets, concurrency limits, and body-size limits.
See their respective pages for configuration.

The daemon also retries failed deliveries and provides a fallback for [wake triggers, reminders,
and background jobs](./deferred-work.md) when the host scheduler is unavailable.

### One daemon per home

A daemon holds a lock on its `$JAZZ_HOME` for as long as it runs. A second `jazz daemon` against
the same home, even on another port, refuses to start and says so. Give it its own `--data-dir`
to run two. A daemon that crashed leaves nothing that blocks the next one.

---

## When it needs you

Work the daemon runs alone stops and waits when it needs a person: a run asking to approve a
command, a question only you can answer, a goal stopped for review, a loop that failed three
times. The daemon tells you the moment that happens, once per item, through the
[`notify` targets](../configure/notifications.md): a desktop notification on the machine (the
default while `notify.targets` is unset), a push to your phone through an [ntfy](https://ntfy.sh)
topic, a JSON POST to a URL of yours (HMAC-signed when you give it a secret), or a Telegram or
Discord message. Each notification says what waits and the command that answers it, and goes
through the notify outbox, so a target that is down gets it once it is back.

```bash
jazz daemon status   # running or paused, what it spent today, and everything waiting for you
```

Over HTTP, `GET /waiting` lists the same items, and `GET /events` streams them as server-sent
events: a `snapshot` when you connect, then `waiting` when something starts waiting, `resolved`
when it is answered (from anywhere: chat, `jazz runs`, another client), and `paused` or
`resumed`. `GET /status` returns what `jazz daemon status` prints. These need the daemon token,
like every route but `/health`.

## Pause background work and limit spend

`jazz daemon pause` stops the daemon starting work of its own: goal cycles, loop runs, wake
triggers, scheduled workflows, background jobs, and new `POST /runs`, webhook, and peer
requests, which get a `503` saying why. Work already running finishes, and anything waiting on
you can still be answered. `jazz daemon resume` starts it again. The HTTP equivalents are
`POST /daemon/pause` and `POST /daemon/resume`.

Each run the daemon starts is held to the agent loop's own limits, but nothing else bounds the
sum. `daemon.dailyCostUSD` and `daemon.dailyTokens` do: once unattended runs have spent that
much since local midnight (read from the machine-wide spend ledger), the daemon pauses itself
until midnight and tells you. An unattended run today with no pricing does the same to the dollar
cap, since what it spent is unknown; on a model nobody has priced use `dailyTokens`. Your chat
turns never count. `jazz daemon resume` lifts both daily caps for the rest of that day, whether
or not a daemon was running to pause; it never lifts a monthly cap. Monthly, per-agent and goal
caps sit beside these keys; see [daily and monthly caps](budgets.md#daily-and-monthly-caps).

---

## Authentication

`GET /health` is unauthenticated on purpose: a process supervisor should be able to see that the
daemon is alive without holding a credential that can drive an agent. It returns
`{ "ok": true, "owner": "<id>" }`, where `owner` is the random instance id of the Jazz home the
daemon serves (stored once in `$JAZZ_HOME/instance-id`), so a client can tell whether the daemon
on the port is its own. It reveals nothing about the machine or its paths.

Everything else needs a bearer token, **including on loopback**. That covers paths matching no
route.

On its first start with no token set, Jazz generates one and prints it once, so you can copy it
to a client. It goes to the OS keyring, or to a `chmod 600` `$JAZZ_HOME/secrets.json` where there
is no keyring.

The saved token is not printed again.

```bash
jazz daemon set-token      # generate (or store $JAZZ_DAEMON_TOKEN); prints a generated value
jazz daemon forget-token   # remove it
```

If nothing can store a token at all, a loopback daemon warns and serves unauthenticated rather
than refusing to start. A non-loopback bind refuses outright. (That happens when
`$JAZZ_DISABLE_KEYRING` is set and `$JAZZ_DAEMON_TOKEN` is not.)

Set `$JAZZ_DAEMON_TOKEN` yourself when the value has to be known in advance. Two cases: a client
config written before the daemon has ever run, and a container whose `$JAZZ_HOME` will not
survive the next deploy.

### HTTP client requirements

HTTP clients must send JSON bodies with `Content-Type: application/json` and omit `Origin`.
Requests with an `Origin` header receive `403`; unsupported body types receive `415`.
Webhooks accept the body type supplied by their sender and use their own authentication.

Peers and webhooks do not use this token. Each has its own. A credential that can start runs is
a much bigger grant than one that can ask a question.

### Granting authority over HTTP

Approving actions or changing agent permissions over HTTP requires a second credential:
the **operator token**, sent in `X-Jazz-Operator-Token`.

| Request                                                                       | Needs the operator token     |
| ----------------------------------------------------------------------------- | ---------------------------- |
| `POST /goals/:id/accept`, `POST /goals/:id/resume`                            | yes                          |
| `POST /loops` (start a loop), `POST /loops/:loop/resume`                      | yes                          |
| `POST /runs/:id/answer` that approves or answers                              | yes                          |
| `POST /daemon/resume` (also lifts a daily-cap pause)                          | yes                          |
| `POST`, `PATCH`, `DELETE` on `/agents` and `/personas`                        | yes                          |
| `POST /runs/:id/answer` that rejects                                          | no, the daemon token will do |
| `POST /runs`, `POST /goals` (a proposal), `POST /daemon/pause`, pause, cancel | no                           |
| every read                                                                    | no                           |

The daemon has no routes to change Jazz configuration, register webhooks or peers, or enable
plugins. Use the CLI on the host for those changes.

```bash
jazz daemon operator-token          # generate, store in the OS keyring, print once
jazz daemon forget-operator-token   # the daemon then grants nothing over HTTP
```

Restart the daemon after changing its operator token. This token requires an OS keyring;
there is no file or environment-variable fallback. The command refuses to run inside a
process started by a Jazz agent. A daemon started by an agent cannot grant authority over HTTP.

Without an operator token, approve actions locally with `jazz runs approve <id>`,
`jazz goal accept`, or `jazz loop start`. An agent with shell access may still access the
keyring directly; this credential boundary protects against escalation through read and HTTP tools.

### Reaching it from another machine

Bind an interface other than loopback, and pass the token on every request:

```bash
# On the host
jazz daemon --host 0.0.0.0

# From another machine, using your saved daemon token
curl http://<host>:4747/runs \
  -H "Authorization: Bearer <your-daemon-token>"
```

`0.0.0.0` binds every interface. What that reaches is whatever your firewall or router allows, so
bind one interface's address if you mean one network.

Restrict access to the port with your firewall or private network. See
[Surface access](../security/surface-access.md).

---

## Running it persistently

`jazz daemon` backgrounds itself and writes a pidfile under `$JAZZ_HOME`; `jazz daemon stop`
ends it. Use `--foreground` when something else, a supervisor or a container entrypoint, expects
to own the process. Starting a goal or a loop starts a background daemon for you when none is
running.

A background daemon is not supervised: after a reboot or a crash nothing starts it again, and
accepted goals, loops, wake triggers, reminders and job batches wait until it does. `jazz goal
start`, `jazz loop start` and the other commands that hand work to the daemon say so when no
service is installed.

Starting on boot and restarting on crash is the host's job. `jazz daemon install` wires it into
the OS supervisor (`systemd` on Linux, `launchd` on macOS) instead of leaving that hand-written:

```bash
sudo jazz daemon install                          # goals, loops, triggers, reminders, jobs
sudo jazz daemon install --serve-peers my-agent   # the same, and answer peers with my-agent
sudo jazz daemon uninstall
```

Both need root. Installation checks `/health` before reporting success. The
service runs as you, never as root, with `JAZZ_HOME` set to your `~/.jazz`. Its token lives in
`/etc/jazz/daemon.env` (mode `0600`): root-owned under systemd, which reads it before switching
to your account, and owned by you under launchd, whose wrapper shell reads it as you.

### Is it working?

```bash
jazz daemon status          # running? pid, supervised, last tick, runs in flight, what waits, errors
jazz daemon status --json   # the same as one JSON envelope; exits 1 when it is not running
jazz daemon logs -n 100     # recent output
jazz daemon logs -f         # follow it
```

A background daemon and the launchd service write their output to `$JAZZ_HOME/logs/daemon.log`,
which rotates with the rest of the logs directory (see
[sizes and retention](../runtime-data/index.md#sizes-and-retention)). Under systemd the service
logs to the journal, and `jazz daemon logs` runs `journalctl -u jazz-daemon` for you. A failed
tick is written to the daemon's output and to `jazz.log`, and the last ten are kept in the status
that `jazz daemon status` shows.

### What is waiting on it

Agents schedule work for later on their own. These commands show it and let you stop it:

```bash
jazz reminders list [--agent <agent>] [--json]    # reminders set with remind_me
jazz reminders cancel <id>
jazz triggers list [--agent <agent>] [--json]     # wake-ups that resume a conversation
jazz triggers cancel <id>
jazz jobs list [--agent <agent>] [--json]         # background job batches
jazz jobs cancel <id>
```

Cancelling removes the host scheduler's job too, the same as when the agent cancels it itself.

---

## Related

- [Scheduled runs](../surfaces/scheduled.md): the ticker the daemon owns in `in-process` mode
- [Agent-to-agent](./agent-to-agent.md): what `--serve-peers` turns on, and its credential model
- [Webhooks](./webhooks.md): the other thing a daemon serves, and its
  [build-one guide](../guides/webhook-endpoint.md)
- [`jazz daemon`](../commands.md): every flag and subcommand
- [Threat model](../security/threat-model.md): what the token does and does not protect
