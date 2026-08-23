# Reminders

This page explains how agent reminders are stored, parsed, and delivered.

Source:
[`services/reminder-service.ts`](../../src/services/reminder-service.ts) ·
[`interfaces/reminder-service.ts`](../../src/core/interfaces/reminder-service.ts) ·
[`tools/reminder-tools.ts`](../../src/core/agent/tools/reminder-tools.ts) ·
[`utils/time.ts`](../../src/core/utils/time.ts)

---

## What it is

A file-backed reminder list the agent manages with three tools — `add_reminder`,
`list_reminders`, and `cancel_reminder`. Reminders are scoped by `Agent.id`, so they follow
the agent across CLI, Telegram, and other surfaces rather than disappearing with a session.

`when` specs are timezone-aware: relative durations (`30m`, `1h30m`), a 24h clock time
(`18:00` → next occurrence), or `tomorrow HH:MM`. Clock times use the execution context
timezone when the surface supplies one, otherwise UTC.

## On disk

```text
~/.jazz/reminders/<agentId>.json     pending reminders for that agent
~/.jazz/reminders/<agentId>.lock/    directory-mutex around read-modify-write
```

A periodic sweep delivers due reminders to the surface that is currently running the agent.
Late delivery is preferred to dropping a reminder if the process was down at fire time.

## Guardrails

Per-agent count and text-length caps live in `core/constants/reminders.ts`. Invalid `when`
specs return a failed tool result the model can correct; they do not throw and kill the run.
