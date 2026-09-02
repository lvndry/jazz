---
description: "The daemon is what lets Jazz act without a terminal open: serving runs over HTTP, owning the schedule ticker, answering peers, and serving webhooks."
---

# Daemon — Jazz without a terminal attached

`jazz chat` and `jazz run` are one process talking to one terminal. That's fine until you
need something to happen when nobody's typing: a scheduled workflow firing at 6 AM, a
webhook from GitHub landing at 2 PM, a run parked on an approval that the person who can
answer it is on a different machine entirely.

`jazz daemon` is that "something." It's the same agent runtime, but reachable over HTTP
instead of a REPL, and able to sit there running with nobody attached.

---

## The short version

```bash
# Start it
jazz daemon

# From another terminal (or another machine): start a run
curl -X POST http://localhost:4747/runs \
  -d '{"agent":"default","prompt":"summarize today'\''s deploys"}'

# Poll it
curl http://localhost:4747/runs/<runId>

# If it parked on an approval, answer it
curl -X POST http://localhost:4747/runs/<runId>/answer -d '{"approved":true}'
```

`jazz runs` (list/show/approve/reject) is the same thing from the CLI, and works whether or
not a daemon is involved — a daemon just means the run can be answered from somewhere other
than the process that started it.

---

## What it actually does

One process, four jobs, each opt-in:

- **Serves runs over HTTP.** `POST /runs` starts one, `GET /runs/:id` polls it, `POST
  /runs/:id/answer` approves or rejects what it's parked on, `GET /runs` lists what's in
  flight. This is the only way to answer a parked run from a different process than the one
  that started it.
- **Owns the schedule ticker**, if `scheduler.mode` is set to `in-process`. Workflow
  schedules normally ride your OS scheduler (`launchd`/`cron`), which only fires while the
  machine is awake; the daemon's own ticker is the alternative for a host you mean to leave
  running. See [Scheduling](./scheduling.md).
- **Answers peers**, if started with `--serve-peers <agentId>`. `POST /peer/ask` and `POST
  /a2a` both need a running daemon to have anyone to ask — without it, your agent can still
  ask *other* peers, but nobody can ask yours. See [Peers](./agent-to-agent.md).
- **Serves webhooks.** `POST /webhooks/<name>` wakes the agent that webhook is configured
  for. See [Webhooks](./webhooks.md).

It's also the fallback ticker for [wake triggers](../reference/tools.md#wake-triggers): a
trigger normally fires via a one-shot `launchd`/`at` job the host schedules directly, with
no daemon required. The daemon's in-process ticker only matters on a host with neither
(most containers).

None of this needs all of it. A daemon started plain, with no flags, only serves runs and —
if `scheduler.mode` is `in-process` — ticks workflows. Peers and webhooks activate on top of
that, not instead of it.

---

## Authentication

`GET /health` is unauthenticated on purpose — a process supervisor should be able to check
that the daemon is alive without holding a credential that can drive an agent.

Everything else needs a bearer token, but only when it matters: binding to `127.0.0.1` (the
default) needs no token at all, since reaching it already means being on the machine.
Binding anywhere else does. The first time a daemon binds a non-loopback host with no token
already set, Jazz generates one, stores it (OS keyring, or a `chmod 600`
`$JAZZ_HOME/secrets.json` where there's no keyring), and prints it once so you can copy it to
a client.

```bash
jazz daemon set-token      # generate (or store $JAZZ_DAEMON_TOKEN) ahead of the daemon's first run
jazz daemon forget-token   # remove it
```

Set `$JAZZ_DAEMON_TOKEN` yourself instead of letting Jazz generate one when the value needs
to be known in advance — a client config written before the daemon has ever run, or an
ephemeral container whose `$JAZZ_HOME` won't survive to the next deploy.

Peers and webhooks don't use this token — each has its own, checked separately, because a
credential that can start and approve runs is a much bigger grant than one that can only
ask a question or fire one fixed prompt.

---

## Running it persistently

`jazz daemon` runs in the foreground. Restarting it on crash and starting it on boot is your
host's job, not the daemon's — that's what a process supervisor is for. `jazz daemon
install` wires it into your OS's supervisor (`systemd` on Linux, `launchd` on macOS) instead
of leaving that hand-written:

```bash
sudo jazz daemon install --serve-peers my-agent
sudo jazz daemon uninstall
```

Both need root, and `install` doesn't report success until `/health` actually answers.

---

## Related

- [Scheduling](./scheduling.md) — the ticker the daemon owns in `in-process` mode
- [Peers](./agent-to-agent.md) — what `--serve-peers` turns on, and its own credential model
- [Webhooks](./webhooks.md) — the other thing a daemon serves
- [CLI reference → `jazz daemon`](../reference/cli.md#jazz-daemon) — every flag and command
- [Lexicon](./lexicon.md) — run, park, approval
