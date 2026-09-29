---
description: "Configure Jazz agents, models, workflows, MCP servers, web search, email, calendar, output, telemetry, limits, and project overrides."
---

# Configure Jazz

Choose the setup you need below. Use `jazz config show` to inspect current settings and
`jazz config validate` to check configuration and agent files. For interactive settings,
run `jazz` and type `/settings`.

- [Jazz configuration](./jazz.md) controls runtime defaults, limits, output, telemetry, schedulers, peers, and webhooks.
- [Config file reference](./config-reference.md) lists every key `config.json` accepts, generated from the schema, and [environment variables](./environment-variables.md) lists every variable Jazz reads.
- [Agent configuration](./agents.md) selects primary and companion models, personas, context limits, capabilities, and per-agent restrictions.
- [Workflows](./workflows.md) combine a prompt with scheduling and run overrides.
- [Notifications](./notifications.md) send results, reminders, parked approvals and failures to Telegram, Discord, a signed webhook, or the desktop.
- [Providers](./providers.md) explains cloud and local model credentials.
- [MCP](./mcp.md), [web search](./web-search.md), and [email and calendar](./email-calendar.md) add external capabilities.
- [Plugins](./plugins.md) covers optional trusted code, per-agent enablement, secrets, and authoring.

Global configuration normally lives under `~/.jazz`. A project may provide `./.jazz/config.json` overrides. Read [Jazz configuration](./jazz.md) before editing either file because merge precedence and secret storage differ by field.
