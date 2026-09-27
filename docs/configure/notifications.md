---
description: "Send Jazz's unattended results, reminders, parked approvals, failures and spend-ceiling alerts to Telegram, Discord, a signed webhook, or the desktop, with retry and approve-from-chat."
---

# Notifications

How to hear from Jazz when nobody is at the terminal.

A scheduled workflow, a goal, a loop or a wake-up turn runs while you are away. A notify channel
is where it tells you what happened: one binding in `config.json`, used by every entry point.

## What you hear about

| Event               | When                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workflow-result`   | A workflow run finished. Only the channels its `deliver:` field names receive it                                        |
| `reminder`          | A reminder fired on a host where no desktop notification can be shown (a server, a system service)                      |
| `approval-needed`   | An unattended run parked on an approval or a question, with the run id and how to answer it                             |
| `unattended-failed` | A workflow, goal cycle, loop run, wake-up turn, job batch, webhook or `jazz run` failed with nobody watching            |
| `spend-ceiling`     | A [spend ceiling](../concepts/budgets.md#day-and-month-ceilings) stopped an unattended run; once per ceiling and window |

A channel gets every event except workflow results unless `events` narrows it. A workflow's
`deliver:` channels also get its failures and approval requests.

## Channels

```jsonc
{
  "notifications": {
    "channels": {
      "phone": { "type": "telegram", "chatId": "123456789", "approveFromChat": true },
      "team": { "type": "discord", "events": ["unattended-failed", "spend-ceiling"] },
      "ops": { "type": "webhook", "url": "https://hooks.example.com/jazz" },
      "desk": { "type": "desktop", "events": ["approval-needed"] },
    },
  },
}
```

Add one with `jazz notify add`, which asks for the secret on a terminal and stores it in the
keyring:

```sh
jazz notify add phone --type telegram --chat-id 123456789 --approve-from-chat
jazz notify test phone
```

| Type       | Fields                                                          | Secret (keyring)                |
| ---------- | --------------------------------------------------------------- | ------------------------------- |
| `telegram` | `chatId`, optional `apiBaseUrl`, `approveFromChat`              | `botToken`                      |
| `discord`  | a channel webhook, or `channelId` with a bot; `approveFromChat` | `webhookUrl`, or `botToken`     |
| `webhook`  | `url`                                                           | `secret` (signs every delivery) |
| `desktop`  | none                                                            | none                            |

Channel names are lowercase letters, digits, `-` and `_`. Each secret can also come from the
environment, for a host with no keyring: `JAZZ_NOTIFY_<NAME>_<FIELD>`, for example
`JAZZ_NOTIFY_PHONE_BOT_TOKEN` or `JAZZ_NOTIFY_TEAM_WEBHOOK_URL`. Set one by hand with
`jazz config set notifications.channels.phone.botToken`.

For Telegram, the bot must be able to post in the chat: send it a message first, then read the
chat id from `https://api.telegram.org/bot<token>/getUpdates`.

## Nothing is lost

Every notification is written to an outbox under `$JAZZ_HOME/notify/outbox` before anything
sends it. The daemon delivers it on its next tick; a `jazz run` or scheduled workflow delivers
what it queued before it exits, so a host without a daemon still delivers.

A send that fails because the channel is down, rate-limited (429) or erroring (5xx) is kept with
its error and retried: one minute, then doubling up to an hour, five attempts in all. A refusal
(a wrong token, a chat the bot cannot post in) stops retrying at once and stays visible.

```sh
jazz notify outbox   # what is waiting, the last error, the next retry
jazz notify retry    # re-arm the given-up ones and send everything now
```

## Webhook signatures

A webhook channel POSTs JSON: `{ id, type, title, text, event }`. Every delivery carries:

| Header                 | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| `X-Jazz-Event`         | the event kind                                        |
| `X-Jazz-Delivery`      | a delivery id; the same on a retry, so dedupe on it   |
| `X-Jazz-Timestamp`     | Unix seconds when it was sent                         |
| `X-Jazz-Signature-256` | `sha256=` hex HMAC-SHA256 of `<timestamp>.<raw body>` |

Recompute the HMAC with the shared secret, compare in constant time, and reject timestamps more
than a few minutes from your clock. Jazz refuses to send to a webhook channel without a secret.

## Approving from chat

When a Telegram or Discord channel points at a chat that a running Jazz bridge serves, set
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

- [Budgets](../concepts/budgets.md): per-run caps and day and month ceilings
- [Deferred work](../concepts/deferred-work.md): reminders, wake triggers and at-least-once delivery
- [Approvals](../security/approvals.md): parking and answering runs
- [Workflow frontmatter](./workflows.md): the `deliver:` field
