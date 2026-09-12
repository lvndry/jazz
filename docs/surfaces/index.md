---
description: "Compare Jazz in the terminal, scripts, CI, scheduled workflows, chat bots, webhooks, and agent-to-agent peer connections."
---

# Where Jazz runs

A surface is a front door onto the same agent runner. The model, tools, memory, and core safety model remain the same; interaction, identity, persistence, and approval handling change.

## Interactive

- **Terminal:** streams reasoning and tool activity, accepts attachments, and asks for approvals or missing input.
- **Chat bots:** Telegram, Discord, iMessage, and WhatsApp bridge each external conversation to a stable Jazz conversation.

## Unattended

- **Headless:** `jazz run` provides a strict stdout, stderr, JSON, event, and exit-code contract for scripts and services.
- **Scheduled:** workflows run through launchd, cron, or the daemon's in-process scheduler and apply catch-up rules after downtime.
- **CI:** a headless run with explicit limits, a pinned agent, and a noninteractive approval policy.
- **Webhooks:** authenticated HTTP endpoints invoke fixed prompt templates with per-door tool ceilings.

## Agent-to-agent

Peers are explicitly configured remote agents. Unlike webhooks, they accept an open-ended request, so identity, disclosure, and tool ceilings are central to the contract.

Read the dedicated pages for [headless runs](./headless.md), [scheduled work](./scheduled.md), [CI](./ci.md), and [chat platforms](./chat.md). Webhooks have a [concept page](../concepts/webhooks.md) and a [build-one guide](../guides/webhook-endpoint.md).
