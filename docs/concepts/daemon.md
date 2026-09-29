---
description: "The daemon is what lets Jazz act with no terminal open: serving runs over HTTP, owning the schedule ticker, answering peers, and serving webhooks."
---

# Daemon

A chat (`jazz`, or `jazz agent chat`) and `jazz run` are one process talking to one terminal. Some things have to happen
when nobody is typing:

- a scheduled workflow firing at 6 AM,
- a webhook from GitHub landing at 2 PM,
- a parked run that only somebody at another machine can approve.

`jazz daemon` is that something. Same agent runtime, reachable over HTTP instead of a REPL.

---

## The short version

```bash
# Start it. It backgrounds itself
jazz daemon

# From another terminal, or another machine: start a run
curl -X POST http://localhost:4747/runs \
  -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","prompt":"summarize today'\''s deploys"}'

# Poll it
curl http://localhost:4747/runs/<runId> -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN"

# If it parked on an approval, approve it (a grant, so it needs the operator token too)
curl -X POST http://localhost:4747/runs/<runId>/answer \
  -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN" \
  -H "X-Jazz-Operator-Token: $JAZZ_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"approved":true}'
```

`jazz runs` (list, show, approve, reject) is the same thing from the CLI, and works whether or
not a daemon is involved. A daemon just means the run can be answered from somewhere other than
the process that started it.

---

## What it actually does

One process, several jobs, most of them opt-in:

- **Serves runs over HTTP.** `POST /runs` starts one, `GET /runs/:id` polls it,
  `POST /runs/:id/answer` approves or rejects what it is parked on, `GET /runs` lists what is in
  flight. This is the only way to answer a parked run from a different process than the one that
  started it.
- **Owns accepted goals.** `POST /goals` creates a proposed goal, and versioned `POST /goals/:id/{accept,pause,resume,cancel}` routes control its lifecycle. `GET /goals` and `GET /goals/:id` read state. The daemon claims and advances goal cycles; if it is stopped, goals remain saved and wait for it to return.
- **Runs loops.** `POST /loops` starts one (`agentId`, `prompt`, `every`, absolute `workingDirectory`, optional `timezone`, `name`, `approvalPolicy`, `maxRuns`), and versioned `POST /loops/:loop/{pause,resume,cancel}` routes control it. `GET /loops` and `GET /loops/:loop` read state. Each tick starts the loops that are due; if the daemon is stopped, loops wait and their missed runs collapse into one.
- **Serves the agent catalogue.** `GET`/`POST`/`DELETE` on `/agents`, `/personas`, plus
  `/catalog`, `/models` and `/tools`. This is what an agent editor talks to, so a UI never has to
  parse JSON files on disk or reimplement validation. Writes need the
  [operator token](#granting-authority-over-http).
- **Owns the schedule ticker**, when `scheduler.mode` is `in-process`. Schedules normally ride the
  OS scheduler, which only fires while the machine is awake. The daemon's ticker is the
  alternative on a host you leave running. See [Scheduled runs](../surfaces/scheduled.md).
- **Answers peers**, when started with `--serve-peers <agentId>`. `POST /peer/ask` and `POST
/a2a` need a running daemon to have anyone to ask. Without one your agent can still ask
  _other_ peers, but nobody can ask yours. See [Agent-to-agent](./agent-to-agent.md).
- **Serves webhooks.** `POST /webhooks/<name>` wakes the agent that webhook names. See
  [Webhooks](./webhooks.md).

Webhook and peer runs are bounded per door: a budget, a concurrency cap (`429` past it), and a
body cap. Each keyring credential they check is read once and trusted for 30 seconds, so a burst
of requests does not spawn a keyring process each, and a rotated token takes effect without a
restart.

It is also the fallback ticker for [wake triggers and reminders](./deferred-work.md): a trigger
normally fires through a one-shot `launchd`/`at` job the host schedules directly, with no daemon
required. The in-process ticker matters on a host with neither, which mostly means containers,
and for retrying a delivery that failed.

### How a tick works

Every few seconds the daemon claims what is due (workflow slots, wake triggers, reminders, goal
cycles, loop runs, job batches) and starts each piece of work on its own. The tick itself only
reads files and takes short locks, so a thirty-minute workflow never delays a reminder, and a
long job drain is not started twice.

A workflow slot is decided and recorded in one step under the run-history lock, so a daemon and a
CLI starting up cannot both run the same slot. Run history keeps the last 20 runs of each
schedule, so a workflow that runs every few minutes cannot push another's record out and make it
run again. A slot missed by more than its catch-up window is recorded as `skipped`, and a run
whose process died is marked `interrupted` the next time a daemon or CLI starts, instead of
staying `running` forever. Catch-up runs use the workflow's declared approval policy (unset
means no automatic approval), and a run without a usable answer is recorded as failed.

### One daemon per home

A daemon holds a lock on its `$JAZZ_HOME` for as long as it runs. A second `jazz daemon` against
the same home, even on another port, refuses to start and says so. Give it its own `--data-dir`
to run two. A daemon that crashed leaves nothing that blocks the next one.

None of this needs all of it. A daemon started plain serves runs and the catalogue, and ticks
workflows if `scheduler.mode` says so. Peers and webhooks activate on top of that, not instead
of it.

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

## Pausing it, and its daily cap

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
route, so an unauthenticated caller cannot map the door by telling 404s from 401s.

On its first start with no token set, Jazz generates one and prints it once, so you can copy it
to a client. It goes to the OS keyring, or to a `chmod 600` `$JAZZ_HOME/secrets.json` where there
is no keyring.

It is never printed again. A supervisor's logs should not accumulate the secret.

```bash
jazz daemon set-token      # generate (or store $JAZZ_DAEMON_TOKEN); prints a generated value
jazz daemon forget-token   # remove it
```

Loopback used to need no token. The reasoning was that reaching `127.0.0.1` means you are already
on the machine.

That ignores loopback's two real neighbours: every other user account on a shared host, and every
page open in your browser. The browser half is handled structurally, below. For the other,
nothing but a token stands between a local process and an agent with filesystem access.

If nothing can store a token at all, a loopback daemon warns and serves unauthenticated rather
than refusing to start. A non-loopback bind refuses outright. (That happens when
`$JAZZ_DISABLE_KEYRING` is set and `$JAZZ_DAEMON_TOKEN` is not.)

Set `$JAZZ_DAEMON_TOKEN` yourself when the value has to be known in advance. Two cases: a client
config written before the daemon has ever run, and a container whose `$JAZZ_HOME` will not
survive the next deploy.

### It does not answer your browser

A loopback port is inside the trust boundary of every page you have open, and a page can POST to
`127.0.0.1` without you doing anything. Two checks close that, on every door:

- **A request carrying an `Origin` header is refused with `403`.** Nothing that legitimately
  drives this daemon sets one: not a CLI, not `curl`, not a supervisor's health probe, not
  another Jazz. A browser sets it on every cross-origin request and cannot be talked out of it,
  so its presence identifies the wrong kind of client.
- **A request body must be `content-type: application/json`** (`415` otherwise). An HTML form can
  only send urlencoded, multipart, or `text/plain`; anything else makes the browser ask
  permission first, and these doors answer no such preflight. The webhook door is the one
  exception, since its body is whatever the sending system sends, and it is gated by a per-webhook
  token no page could hold.

Writing a client? Send `application/json` and no `Origin`, which is what every ordinary HTTP
client already does.

Peers and webhooks do not use this token. Each has its own. A credential that can start runs is
a much bigger grant than one that can ask a question.

### Granting authority over HTTP

The daemon token proves a request came from a client of the daemon. It cannot prove the client is
you. It sits in `$JAZZ_DAEMON_TOKEN` or, on a host with no OS keyring, in
`$JAZZ_HOME/secrets.json`, and an agent that can read a file and send an HTTP request could
replay it to accept its own goal at `high-risk` or approve its own parked run.

So the requests that grant authority need a second credential, the **operator token**, in
`X-Jazz-Operator-Token`:

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

Every write to an agent or a persona counts, whichever field it touches. An agent's config
decides what all of its runs may do (tools, MCP servers, model and provider, memory scopes,
custom commands) and a persona's tool profile narrows or widens that, so there is no field an
agent could safely rewrite for itself. The daemon has no routes that write the Jazz config,
register a webhook or peer, or enable a plugin; those are CLI-only. Redeeming a peer invite is
authenticated by the invite's one-time secret and grants only the tier the operator chose when
creating it.

```bash
jazz daemon operator-token          # generate, store in the OS keyring, print once
jazz daemon forget-operator-token   # the daemon then grants nothing over HTTP
```

Restart the daemon after either. The operator token is kept where an agent's read tools cannot
reach it:

- **Only in the OS keyring,** the macOS keychain or the Linux Secret Service. Never in the
  `secrets.json` fallback and never in an environment variable, since a process's environment is
  readable at `/proc/<pid>/environ` by anything running as the same user. A host with no OS
  keyring has no operator token.
- **Minted only by you.** `jazz daemon operator-token` refuses to run inside a process a Jazz
  agent started, and a daemon an agent started grants nothing over HTTP, whatever it is sent.
- **Never loaded into config,** so nothing that prints config can show it.

Without an operator token the daemon still serves everything else, and you grant from the CLI on
the machine instead: `jazz runs approve <id>`, `jazz goal accept`, `jazz loop start`. Those act on
the same stores directly and need no daemon.

This does not stop an agent that has a shell: it can ask the keychain for the entry itself. Such
an agent already holds more than any grant could add. What the operator token closes is the
escalation from read-and-send tools to `high-risk`.

### Reaching it from another machine

Bind an interface other than loopback, and pass the token on every request:

```bash
# On the host
jazz daemon --host 0.0.0.0
# → Generated a daemon token and stored it in <keyring>: <token>

# From another machine
curl http://<host>:4747/runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","prompt":"summarize today'\''s deploys"}'
```

`0.0.0.0` binds every interface. What that reaches is whatever your firewall or router allows, so
bind one interface's address if you mean one network.

Scope who can reach the port, not just who holds the token. See
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

Both need root, and `install` does not report success until `/health` actually answers. The
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
