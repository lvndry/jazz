---
description: "The daemon is what lets Jazz act with no terminal open: serving runs over HTTP, owning the schedule ticker, answering peers, and serving webhooks."
---

# Daemon: Jazz with no terminal attached

`jazz chat` and `jazz run` are one process talking to one terminal. That is fine until
something has to happen when nobody is typing: a scheduled workflow firing at 6 AM, a webhook
from GitHub landing at 2 PM, a run parked on an approval that only somebody at a different
machine can answer.

`jazz daemon` is that something. Same agent runtime, reachable over HTTP instead of a REPL, and
able to sit there running with nobody attached.

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

# If it parked on an approval, answer it
curl -X POST http://localhost:4747/runs/<runId>/answer \
  -H "Authorization: Bearer $JAZZ_DAEMON_TOKEN" \
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
- **Serves the agent catalogue.** `GET`/`POST`/`DELETE` on `/agents`, `/personas`, plus
  `/catalog`, `/models` and `/tools`. This is the read and write surface an agent editor needs, so a UI
  never has to parse JSON files on disk or reimplement validation.
- **Owns the schedule ticker**, when `scheduler.mode` is `in-process`. Workflow schedules
  normally ride the OS scheduler (`launchd`, `cron`), which only fires while the machine is
  awake; the daemon's own ticker is the alternative on a host you mean to leave running. See
  [Scheduled runs](../surfaces/scheduled.md).
- **Answers peers**, when started with `--serve-peers <agentId>`. `POST /peer/ask` and `POST
/a2a` need a running daemon to have anyone to ask. Without one your agent can still ask
  _other_ peers, but nobody can ask yours. See [Agent-to-agent](./agent-to-agent.md).
- **Serves webhooks.** `POST /webhooks/<name>` wakes the agent that webhook names. See
  [Webhooks](./webhooks.md).

It is also the fallback ticker for [wake triggers](../tools/index.md): a trigger normally fires
through a one-shot `launchd`/`at` job the host schedules directly, with no daemon required. The
in-process ticker only matters on a host with neither, which mostly means containers.

None of this needs all of it. A daemon started plain serves runs and the catalogue, and ticks
workflows if `scheduler.mode` says so. Peers and webhooks activate on top of that, not instead
of it.

---

## Authentication

`GET /health` is unauthenticated on purpose: a process supervisor should be able to see that the
daemon is alive without holding a credential that can drive an agent.

Everything else needs a bearer token, **including on loopback**, and including paths that match
no route, so an unauthenticated caller cannot map the door by telling 404s from 401s. The first
time a daemon starts with no token set, Jazz generates one, stores it (OS keyring, or a
`chmod 600` `$JAZZ_HOME/secrets.json` where there is no keyring), and prints it once so you can
copy it to a client. It is not reprinted on later starts, so a supervisor's logs never
accumulate the secret.

```bash
jazz daemon set-token      # generate (or store $JAZZ_DAEMON_TOKEN); prints a generated value
jazz daemon forget-token   # remove it
```

Loopback used to need no token, on the reasoning that reaching `127.0.0.1` already means being
on the machine. That ignores loopback's two real neighbours: every other user account on a
shared host, and every page open in your browser. The browser half is handled structurally, as below.
But nothing except a token separates a tokenless loopback daemon from any other local process, and what it guards is an agent with filesystem access.

If nothing can store a token at all (`$JAZZ_DISABLE_KEYRING` set with no `$JAZZ_DAEMON_TOKEN`),
a loopback daemon warns and serves unauthenticated rather than refusing to start; a non-loopback
bind refuses outright.

Set `$JAZZ_DAEMON_TOKEN` yourself instead of letting Jazz generate one when the value has to be
known in advance: a client config written before the daemon has ever run, or an ephemeral
container whose `$JAZZ_HOME` will not survive to the next deploy.

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

Peers and webhooks do not use the daemon token. Each has its own, checked separately, because a
credential that can start and approve runs is a much bigger grant than one that can ask a
question or fire one fixed prompt.

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

`0.0.0.0` binds every interface, so reachability beyond that is whatever your firewall or router
already allows. Bind a specific interface's address instead if you mean one network and not
"anywhere this host has a route". Either way the token is the only thing between that interface
and an agent with filesystem access, so scope who can reach the port, not just who holds the
token. See [Surface access](../security/surface-access.md).

---

## Running it persistently

`jazz daemon` backgrounds itself and writes a pidfile under `$JAZZ_HOME`; `jazz daemon stop`
ends it. Use `--foreground` when something else, a supervisor or a container entrypoint, expects
to own the process.

Starting on boot and restarting on crash is the host's job. `jazz daemon install` wires it into
the OS supervisor (`systemd` on Linux, `launchd` on macOS) instead of leaving that hand-written:

```bash
sudo jazz daemon install --serve-peers my-agent
sudo jazz daemon uninstall
```

Both need root, and `install` does not report success until `/health` actually answers.

---

## Related

- [Scheduled runs](../surfaces/scheduled.md): the ticker the daemon owns in `in-process` mode
- [Agent-to-agent](./agent-to-agent.md): what `--serve-peers` turns on, and its credential model
- [Webhooks](./webhooks.md): the other thing a daemon serves, and its
  [build-one guide](../guides/webhook-endpoint.md)
- [`jazz daemon`](../commands.md): every flag and subcommand
- [Threat model](../security/threat-model.md): what the token does and does not protect
