---
description: "Send approvals, daemon pauses, results, failures, reminders and spend alerts to the desktop, ntfy, webhooks, Telegram or Discord, with retries and chat approvals."
---

# Notifications

Configure a notification target to receive results, reminders, failures, and approval requests
while you are away.

`notify.targets` in `config.json` applies to daemon work, schedules, goals, loops, and
`jazz run`.

## Add and test a target

Add one with `jazz notify add`, which asks for the secret on a terminal and stores it in the
keyring:

```sh
jazz notify add phone --kind telegram --chat-id 123456789 --approve-from-chat
jazz notify test phone
```

| Kind       | Fields                                                             | Secret (keyring)                 |
| ---------- | ------------------------------------------------------------------ | -------------------------------- |
| `desktop`  | none                                                               | none                             |
| `ntfy`     | `url` (a topic URL)                                                | none                             |
| `webhook`  | `url`                                                              | `secret`, optional: signs bodies |
| `telegram` | `chatId`, optional `apiBaseUrl`, `approveFromChat`                 | `botToken`                       |
| `discord`  | optional `channelId` (with a bot), `apiBaseUrl`, `approveFromChat` | `webhookUrl`, or `botToken`      |

Every target has a `name` (lowercase letters, digits, `-` and `_`) and an optional `events`
list. Secrets never go in `config.json`: they are in the keyring under
`notify.targets.<name>.<field>` (`jazz config set notify.targets.phone.botToken`), or, on a host
with no keyring, in `JAZZ_NOTIFY_<NAME>_<FIELD>`, for example `JAZZ_NOTIFY_PHONE_BOT_TOKEN` or
`JAZZ_NOTIFY_TEAM_WEBHOOK_URL`.

Pick an ntfy topic name nobody can guess: anyone who knows it can read what you are sent. For
Telegram, the bot must be able to post in the chat: send it a message first, then read the chat
id from `https://api.telegram.org/bot<token>/getUpdates`.

## What you hear about

| Event               | When                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `waiting`           | Something needs you: a parked run's approval, question or file, a goal stopped for review or at its cycle cap, a loop that stopped. Sent once per item |
| `paused`            | The daemon paused its own work at a daily cap                                                                                                          |
| `unattended-failed` | A workflow, goal cycle, loop run, wake-up turn, job batch, webhook or `jazz run` failed with nobody watching                                           |
| `spend-cap`         | A [spend cap](../concepts/budgets.md#daily-and-monthly-caps) refused an unattended run; once per cap and window                                        |
| `reminder`          | A reminder fired on a host where no desktop notification can be shown (a server, a system service)                                                     |
| `workflow-result`   | A workflow run finished. Only the targets its `deliver:` field names receive it                                                                        |

A target gets every event except workflow results unless `events` narrows it. A workflow's
`deliver:` targets also get its failures and approval requests.

## Targets

```jsonc
{
  "notify": {
    "targets": [
      { "name": "desktop", "kind": "desktop", "events": ["waiting", "paused"] },
      { "name": "phone", "kind": "telegram", "chatId": "123456789", "approveFromChat": true },
      { "name": "push", "kind": "ntfy", "url": "https://ntfy.sh/my-private-jazz-topic" },
      { "name": "team", "kind": "discord", "events": ["unattended-failed", "spend-cap"] },
      { "name": "ops", "kind": "webhook", "url": "https://hooks.example.com/jazz" },
    ],
  },
}
```

Unset, `notify.targets` is one desktop target. Once you set it, the list is exactly what you
get: include a `desktop` target to keep desktop notifications. `notifications.enabled: false`
drops desktop targets.

## Desktop notifications

A desktop notification is shown one of two ways, never both.

**In the terminal.** When Jazz runs in a terminal that shows notifications itself, it writes
the notification to that terminal as an escape sequence, and the terminal shows it. This works
while the fullscreen interface is up.

| Terminal | Detected from                                     | Sequence |
| -------- | ------------------------------------------------- | -------- |
| kitty    | `KITTY_WINDOW_ID`, or `TERM=xterm-kitty`          | OSC 99   |
| Ghostty  | `TERM_PROGRAM=ghostty`                            | OSC 777  |
| WezTerm  | `TERM_PROGRAM=WezTerm`                            | OSC 777  |
| Warp     | `TERM_PROGRAM=WarpTerminal`                       | OSC 777  |
| iTerm2   | `TERM_PROGRAM=iTerm.app`, or `LC_TERMINAL=iTerm2` | OSC 9    |

The terminal sends nothing back, so a notification counts as delivered once it was written to
the terminal. Whether it appears then depends on the terminal and the OS allowing it (on macOS,
System Settings, Notifications, then your terminal app). Titles and messages are limited in
length and lose control characters; OSC 777 and OSC 9 also lose `;`, which separates their
fields.

**With the system notifier** everywhere else: in any other terminal (Apple Terminal, GNOME
Terminal and other VTE terminals, VS Code), and in every process with no terminal, such as
`jazz daemon`, scheduled workflows and the chat bridges. On macOS that is `terminal-notifier`.
The release binary bundles it; a Jazz installed another way uses `JAZZ_TERMINAL_NOTIFIER`, then
one on `PATH` or in Homebrew (`brew install terminal-notifier`). On Linux it is `notify-send`
(from libnotify), and it needs a desktop session (`DISPLAY`, `WAYLAND_DISPLAY` or
`DBUS_SESSION_BUS_ADDRESS`).

`notifications.terminal` chooses the terminal sequence, and `JAZZ_NOTIFICATIONS_TERMINAL` wins
over it:

| Value            | Effect                                                   |
| ---------------- | -------------------------------------------------------- |
| `auto` (default) | Detect the terminal as in the table above.               |
| `osc99`          | Always send kitty's sequence.                            |
| `osc777`         | Always send the sequence Ghostty, WezTerm and Warp show. |
| `osc9`           | Always send iTerm2's sequence.                           |
| `off`            | Always use the system notifier.                          |

```sh
jazz config set notifications.terminal osc777
```

- **Over SSH** the remote shell usually has no `TERM_PROGRAM`, so `auto` finds nothing (iTerm2's
  `LC_TERMINAL` is often forwarded, and is detected). Set `notifications.terminal` on the remote
  machine: the sequence travels back over SSH and your laptop's terminal shows it.
- **In tmux** the sequence is wrapped so tmux forwards it, which tmux does only with
  `set -g allow-passthrough on` in `~/.tmux.conf`. tmux replaces `TERM_PROGRAM` with `tmux`, so
  inside tmux `auto` detects kitty and iTerm2 only; set `notifications.terminal` for the others.
- **In GNU screen** the system notifier is always used: screen does not forward these
  sequences.

`notifications.enabled: false` turns off both.

On a host that can show a desktop notification neither way, such as a server or a CI runner:

- nothing is queued for the default desktop target (the one used while `notify.targets` is
  unset), and `jazz notify` says why;
- a `desktop` target you configured yourself still receives events; each one that cannot be
  shown is reported once on stderr with what to install, then dropped instead of retried;
- `jazz notify test <name>` reports the same reason;
- a reminder goes to the notify targets that take reminders instead.

## Delivery and retries

Every notification is written to an outbox under `$JAZZ_HOME/notify/outbox` before anything
sends it. The daemon delivers it on its next tick; a `jazz run` or scheduled workflow delivers
what it queued before it exits, so a host without a daemon still delivers.

A send that fails because the target is down, rate-limited (429) or erroring (5xx) is kept with
its error and retried: one minute, then doubling up to an hour, five attempts in all. A refusal
(a wrong token, a chat the bot cannot post in) stops retrying at once and stays visible. A
desktop notification that cannot be shown is dropped (see
[Desktop notifications](#desktop-notifications)).

An event sent once per key (a waiting item, a spend cap per window) counts as sent on a target
only once it is in that target's outbox. A target whose outbox is full is tried again with the
same event on the next tick; the targets that already have it do not get it twice.

```sh
jazz notify outbox   # what is waiting, the last error, the next retry
jazz notify retry    # re-arm the given-up ones and send everything now
```

## Webhook bodies and signatures

A webhook target POSTs JSON: `{ id, type, title, body, event }`, where `id` is the delivery
id, `type` is the event kind, `title` and `body` are the rendered text, and `event` is the event
itself, with `kind` naming it:

```jsonc
{
  "id": "m1abc-x7k2q9",
  "type": "waiting",
  "title": "A run wants to use execute_command",
  "body": "About to run execute_command\njazz runs approve run-a (or reject)",
  "event": {
    "kind": "waiting",
    "item": {
      "key": "run:run-a:call-1",
      "kind": "approval",
      "title": "A run wants to use execute_command",
      "detail": "About to run execute_command",
      "since": "2026-09-28T09:00:00.000Z",
      "runId": "run-a",
      "agentId": "agent-1",
    },
  },
}
```

| `event.kind`        | Fields besides `kind`                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| `waiting`           | `item`: `key`, `kind`, `title`, `detail`, `since`, and `runId`, `goalId` or `loopId` |
| `paused`            | `pause` (`kind`, `at`, and for a daily cap `limit` and `until`), `reason`            |
| `unattended-failed` | `source`, `error`, optional `name`, `agentId`, `runId`                               |
| `spend-cap`         | `source`, `agentId`, `message`, optional `name`                                      |
| `reminder`          | `agentId`, `text`, `fireAt` (epoch ms)                                               |
| `workflow-result`   | `workflow`, `agentId`, `answer`                                                      |

Every delivery carries:

| Header                 | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| `X-Jazz-Event`         | the event kind                                                         |
| `X-Jazz-Delivery`      | a delivery id; the same on a retry, so dedupe on it                    |
| `X-Jazz-Timestamp`     | Unix seconds when it was sent                                          |
| `X-Jazz-Signature-256` | with a `secret`: `sha256=` hex HMAC-SHA256 of `<timestamp>.<raw body>` |

With a secret, recompute the HMAC, compare in constant time, and reject timestamps more than a
few minutes from your clock. Without one, anyone who learns the URL can post look-alike events,
so treat unsigned bodies as unverified.

## Approving from chat

When a Telegram or Discord target points at a chat that a running Jazz bridge serves, set
`approveFromChat: true`. Approval requests then end with `/approve <runId>` and
`/deny <runId> [why]`, and the bridge answers them:

- Only the bridge's operators are heard: user ids in `TELEGRAM_OPERATOR_IDS` or
  `DISCORD_OPERATOR_IDS`. With none listed, nobody can answer.
- The bridge needs `JAZZ_APPROVALS_HOME` set to the Jazz home whose parked runs it answers
  (usually the operator's `~/.jazz`). Unset, the commands answer that approving from chat is off.
- The answer runs `jazz runs approve` or `jazz runs reject` as the bridge's own process, outside
  any conversation sandbox. That command refuses when an agent's tool started it, so an agent
  cannot approve its own run.

A question (rather than a tool approval) is answered with `jazz runs answer <runId> --response`.
A secret the run asked for is never answered from chat: type it in a terminal with
`jazz runs secret <runId>`.

## Related

- [Budgets](../concepts/budgets.md): per-run caps and daily and monthly caps
- [Daemon](../concepts/daemon.md#when-it-needs-you): what waits on you, pausing
- [Deferred work](../concepts/deferred-work.md): reminders, wake triggers and at-least-once delivery
- [Approvals](../security/approvals.md): parking and answering runs
- [Workflow frontmatter](./workflows.md): the `deliver:` field
