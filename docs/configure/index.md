---
description: "Configure Jazz agents, models, workflows, MCP servers, web search, email, calendar, output, telemetry, limits, and project overrides."
---

# Configure Jazz

Jazz separates application configuration from agent definitions and workflow files.

- [Jazz configuration](./jazz.md) controls runtime defaults, limits, output, telemetry, schedulers, peers, and webhooks.
- [Agent configuration](./agents.md) selects primary and companion models, personas, context limits, capabilities, and per-agent restrictions.
- [Workflows](./workflows.md) combine a prompt with scheduling and run overrides.
- [Providers](./providers.md) explains cloud and local model credentials.
- [MCP](./mcp.md), [web search](./web-search.md), and [email and calendar](./email-calendar.md) add external capabilities.

Global configuration normally lives under `~/.jazz`. A project may provide `./.jazz/config.json` overrides. Read [Jazz configuration](./jazz.md) before editing either file because merge precedence and secret storage differ by field.
