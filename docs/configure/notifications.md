---
description: "Send approvals, daemon pauses, results, failures, reminders and spend alerts to the desktop, ntfy, webhooks, Telegram or Discord, with retries and chat approvals."
---

# Notifications

How to hear from Jazz when nobody is at the terminal.

The daemon, a scheduled workflow, a goal, a loop, or a `jazz run` in a script works while you are
away. `notify.targets` in `config.json` is where all of them tell you what happened: one list,
one outbox, used by every entry point.

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

## Nothing is lost

Every notification is written to an outbox under `$JAZZ_HOME/notify/outbox` before anything
sends it. The daemon delivers it on its next tick; a `jazz run` or scheduled workflow delivers
what it queued before it exits, so a host without a daemon still delivers.

A send that fails because the target is down, rate-limited (429) or erroring (5xx) is kept with
its error and retried: one minute, then doubling up to an hour, five attempts in all. A refusal
(a wrong token, a chat the bot cannot post in, no desktop session) stops retrying at once and
stays visible.

```sh
jazz notify outbox   # what is waiting, the last error, the next retry
jazz notify retry    # re-arm the given-up ones and send everything now
```

## Webhook bodies and signatures

A webhook target POSTs JSON: `{ id, type, title, body, event }`, where `type` is the event kind
and `event` is the event itself (for `waiting`, the item with its `runId`, `goalId` or
`loopId`). Every delivery carries:

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

## Related

- [Budgets](../concepts/budgets.md): per-run caps and daily and monthly caps
- [Daemon](../concepts/daemon.md#when-it-needs-you): what waits on you, pausing
- [Deferred work](../concepts/deferred-work.md): reminders, wake triggers and at-least-once delivery
- [Approvals](../security/approvals.md): parking and answering runs
- [Workflow frontmatter](./workflows.md): the `deliver:` field
