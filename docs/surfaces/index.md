---
description: "Choose where to run Jazz: interactive terminal, scripts, CI, scheduled jobs, chat apps, webhooks, or trusted agent peers."
---

# Where Jazz runs

Choose how you want to reach your agent. Its model, persona, and tools come from the
agent configuration; each surface provides its own conversation and approval controls.

| You want to                                               | Use                                       |
| --------------------------------------------------------- | ----------------------------------------- |
| Work alongside an agent and review actions as they happen | [CLI](./cli.md): `jazz`                   |
| Call an agent from a script and parse the result          | [Headless](./headless.md): `jazz run`     |
| Summarize a pull request or investigate build failures    | [CI](./ci.md)                             |
| Receive a recurring briefing or run a routine job         | [Scheduled runs](./scheduled.md)          |
| Reach an agent from your phone or a team channel          | [Chat platforms](./chat.md)               |
| Start work when another application sends an event        | [Webhooks](../guides/webhook-endpoint.md) |
| Ask another Jazz installation for help                    | [Peers](../guides/connect-peers.md)       |

Start with the [quick start](../getting-started/quick-start.md) if you have not run Jazz
before. For unattended work, choose the agent's permissions and budgets before enabling
its schedule or external entry point. See [Unattended runs](../security/unattended-runs.md).
