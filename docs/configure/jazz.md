---
description: "Configure Jazz runtime limits, context management, output, scheduling, notifications, telemetry, webhooks, peers, MCP trust, and project overrides."
---

# Jazz configuration

Jazz reads global configuration from `~/.jazz/config.json` and optional project overrides from `./.jazz/config.json`.

The merge order is defaults, global configuration, then project configuration. `JAZZ_CONFIG_PATH` or `--config` replaces the global file; it does not disable project overrides. `JAZZ_HOME` or `--data-dir` changes the Jazz data directory.

Agents are separate JSON files under the Jazz home directory. MCP server definitions use the shared `.agents/mcp.json` convention. Do not put either into `config.json`.

## Minimal example

Configuration files are partial overrides, so include only values you intend to change:

```json
{
  "maxIterations": 60,
  "notifications": {
    "enabled": true,
    "sound": false
  },
  "output": {
    "showReasoning": true,
    "collapseReasoning": true,
    "showToolExecution": true,
    "mode": "hybrid"
  }
}
```

Use `jazz config show`, `jazz config get <key>`, or `jazz config set <key> <value>` instead of editing JSON when practical.

## Run budgets

| Key                     | Default | Meaning                                                            |
| ----------------------- | ------: | ------------------------------------------------------------------ |
| `maxIterations`         |   `100` | Reason-and-act cycles for a top-level run                          |
| `maxSubagentIterations` |    `30` | Reason-and-act cycles for each delegated child run                 |
| `maxSubagentDepth`      |     `3` | Delegation levels below the top-level run; `0` disables delegation |
| `maxRetries`            |    `10` | Retries after transient model-provider failures                    |
| `maxCostUSD`            |   unset | Own and delegated model spend in US dollars                        |
| `maxTokens`             |   unset | Own prompt and completion tokens; child tokens are not included    |
| `maxDurationMs`         |   unset | Wall-clock budget with model warnings before termination           |

Cost, token, and duration limits are checked between iterations. One model call or tool phase can cross a limit before Jazz stops the next iteration. An external `--timeout` is a separate hard deadline around the entire run.

Command-line and workflow values override application defaults for that run.

## Context management

```json
{
  "context": {
    "warnThresholdRatio": 0.7,
    "compactThresholdRatio": 0.8
  }
}
```

Both values are fractions of the effective model context window. Jazz requires `warnThresholdRatio < compactThresholdRatio < 0.95`; invalid values are ignored in favor of defaults. See [Long-running work](../features/long-running-work.md).

## Output and notifications

`output.mode` accepts `rendered`, `hybrid`, `raw`, or `quiet`. `JAZZ_OUTPUT_MODE` and `--output` override it. The other output fields control whether reasoning and tool execution are shown and whether completed reasoning collapses.

`notifications.enabled` and `notifications.sound` control desktop completion and approval notifications.

## Scheduling

```json
{
  "scheduler": {
    "mode": "in-process"
  }
}
```

`auto` or an omitted value uses launchd on macOS and cron on Linux. `in-process` makes `jazz daemon` poll schedules, which is useful on an always-running host or container. `JAZZ_SCHEDULER` overrides the saved value.

## Webhooks and peers

`webhooks` defines authenticated, fixed-prompt HTTP doors served by `jazz daemon`. Each entry names an agent and may narrow conversation persistence, disclosure, and allowed tools. Manage its bearer token with `jazz webhook`, not in JSON. [Wake an agent from another system with a webhook](../guides/webhook-endpoint.md) has a complete entry and the request that fires it.

`peers` lists remote Jazz agents this installation has explicitly chosen to trust. Peer credentials belong in the keyring. See [Agent-to-agent](../concepts/agent-to-agent.md).

## MCP overrides

Full MCP server definitions live in `~/.agents/mcp.json` or `./.agents/mcp.json`. Jazz stores only per-server `enabled` and `trusted` overrides in `config.json`.

## Telemetry

Local telemetry is enabled by default. The `telemetry` object controls retention, buffering, and optional OTLP export. Content capture is off by default because prompts, completions, and tool arguments may contain private data. See [Observability](./observability.md).

## Secrets and environment variables

Provider and integration keys should be set through Jazz so it can use the system keyring, or supplied as documented environment variables. Run `jazz config show` to inspect resolved non-secret settings.

Common process-wide overrides include:

- `JAZZ_HOME` — data directory, normally `~/.jazz`;
- `JAZZ_CONFIG_PATH` — replacement global config file;
- `JAZZ_OUTPUT_MODE` — terminal output mode;
- `JAZZ_OFFLINE` — disable network-dependent catalog and update behavior;
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` — outbound proxy configuration;
- `OTEL_*` — OpenTelemetry exporter configuration.

Provider-specific keys and endpoints are listed in [Model providers](./providers.md).
