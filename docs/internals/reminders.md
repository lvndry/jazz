---
description: "How agent reminders are stored, parsed, and delivered in Jazz — from natural-language requests to scheduled notifications."
---

# Reminders

This page explains how agent reminders are stored, parsed, and delivered.

Source:
[`services/reminder-service.ts`](../../packages/adapters/src/reminder-service.ts) ·
[`interfaces/reminder-service.ts`](../../packages/core/src/interfaces/reminder-service.ts) ·
[`tools/reminder-tools.ts`](../../packages/core/src/agent/tools/reminder-tools.ts) ·
[`utils/time.ts`](../../packages/core/src/utils/time.ts) ·
[`wake-triggers/reminder-os-scheduler.ts`](../../packages/core/src/wake-triggers/reminder-os-scheduler.ts) ·
[`utils/desktop-notify.ts`](../../packages/core/src/utils/desktop-notify.ts)

---

## What it is

A file-backed reminder list the agent manages with three tools — `add_reminder`,
`list_reminders`, and `cancel_reminder`. Reminders are scoped by `Agent.id`, so they follow
the agent across CLI, Telegram, and other surfaces rather than disappearing with a session.

`when` specs are timezone-aware: relative durations (`30m`, `1h30m`), a 24h clock time
(`18:00` → next occurrence), `tomorrow HH:MM`, a weekday and time (`tue 20:00` → next
occurrence of that weekday), or an absolute `YYYY-MM-DD HH:MM`. Clock times use the
execution context timezone when the surface supplies one, otherwise UTC.

`add_reminder` refuses a `when` that resolves to a time in the past.

## On disk

```text
~/.jazz/reminders/<agentId>.json     pending reminders for that agent
~/.jazz/reminders/<agentId>.lock/    directory-mutex around read-modify-write
```

Delivery depends on which surface owns the agent:

- **Telegram and Discord**: each bot bridge runs its own 20-second `setInterval` sweep
  (`packages/telegram-bot/src/reminders.ts`, `packages/discord-bot/src/reminders.ts`) and
  delivers due reminders as a chat message, unchanged by anything below.
- **CLI-hosted agents** (`agentId` not prefixed `tg_`/`dc_`): `add_reminder` also installs a
  real one-shot host-scheduler job — the same mechanism `register_trigger` uses for wake
  triggers — so the reminder fires even without `jazz daemon` running. Firing invokes
  `jazz reminder fire --agent <agentId> --id <id>`, which sends a native OS desktop
  notification (`utils/desktop-notify.ts`) rather than resuming a conversation. `jazz daemon`'s
  in-process ticker (`adapters/daemon/trigger-runner.ts`) remains a fallback sweep for hosts
  with neither `launchd` nor `at`, and always skips `tg_`/`dc_` agent ids to avoid delivering
  the same reminder twice.

Late delivery is preferred to dropping a reminder if the process was down at fire time.

## Guardrails

Per-agent count and text-length caps live in `core/constants/reminders.ts`. Invalid `when`
specs return a failed tool result the model can correct; they do not throw and kill the run.
