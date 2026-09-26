---
description: "Configure Jazz runtime limits, context management, output, scheduling, notifications, telemetry, webhooks, peers, MCP trust, and project overrides."
---

# Jazz configuration

Jazz reads global configuration from `~/.jazz/config.json` and optional project overrides from `./.jazz/config.json`.

The merge order is defaults, global configuration, then project configuration. Objects merge key by key at every depth, so a project `llm.ollama.keep_alive` keeps the global `llm.ollama.base_url`; lists such as `peers` and `webhooks` are replaced whole. `JAZZ_CONFIG_PATH` or `--config` replaces the global file; it does not disable project overrides. `JAZZ_HOME` or `--data-dir` changes the Jazz data directory.

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

Use `jazz config show`, `jazz config get <key>`, or `jazz config set <key> <value>` instead of editing JSON when practical. `jazz config validate` checks the global and project files without starting the rest of Jazz, so it remains usable when an invalid file blocks normal startup.

Keys are dot-separated paths. Wrap a segment in double quotes when the key itself contains dots, as model IDs often do, and quote the whole path for the shell:

```bash
jazz config set 'llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash".supportsTools' true
```

Jazz prints paths back the same way in validation messages, so a reported path can be pasted into `jazz config set`.

`jazz config set` stores a value with the type the setting is read back as: `jazz config set maxRetries 5` stores the number `5`, and `jazz config set output.collapseReasoning false` stores the boolean `false`. Text settings such as API keys, paths, `logging.level`, and `llm.ollama.keep_alive` are stored as typed. A value that cannot be read as the setting's type is refused instead of written, because a string in a numeric or boolean field is ignored by everything that reads it:

```console
$ jazz config set maxRetries never
❌ Configuration Validation Error
   Field "maxRetries" expected a whole number, got never

💡 Suggestion: Pass a plain whole number, with no units or quotes — 600000, not 600000ms.
```

It also refuses a key Jazz does not read, suggesting the one a typo most likely meant (`maxRetrys` → `maxRetries`). Lists such as `peers` and `webhooks` are not set one field at a time; use `jazz peers` and `jazz webhook`, or edit the file.

A write changes only the key you set, and only in the global file. Values merged in from a project file, from `--debug`, from environment variables, or from the keyring are never copied into it. Jazz takes a cross-process lock, re-reads the latest file before applying the change, and atomically replaces it, so a concurrent edit is preserved. Unknown or invalid entries remain untouched, but Jazz refuses to overwrite malformed JSON.

## Mistakes in a configuration file

Jazz checks each configuration file before it can affect runtime behavior. A value of the wrong type, an unknown key, or an invalid safety invariant is reported and ignored; valid siblings still load, and Jazz continues with the setting's default. If the JSON itself is malformed, Jazz reports it and uses defaults for that file rather than refusing to start:

```console
jazz: invalid configuration in /home/you/.jazz/config.json (2 entries):
  maxRetries: expected a whole number of 0 or more, got "5"
  maxRetrys: not a setting — did you mean maxRetries?
```

Run `jazz config validate` for the same diagnostics and a non-zero exit status, without constructing the application layer. A daemon that notices an invalid live edit keeps serving its last-known-good configuration and reports the problem; once the file is repaired, a later reload adopts it. A value found where a secret belongs is described by its type and never printed.

## Run budgets

| Key                     | Default | Meaning                                                                                                       |
| ----------------------- | ------: | ------------------------------------------------------------------------------------------------------------- |
| `maxIterations`         |   `100` | Reason-and-act cycles for a top-level run                                                                     |
| `maxSubagentIterations` |    `30` | Reason-and-act cycles for each delegated child run                                                            |
| `maxSubagentDepth`      |     `3` | Delegation levels below the top-level run; `0` disables delegation                                            |
| `maxRetries`            |    `10` | Retries after transient model-provider failures                                                               |
| `editor`                |         | Editor for `jazz persona edit` / `jazz mcp add`, e.g. `code --wait`; falls back to `$VISUAL`, `$EDITOR`, `vi` |
| `maxCostUSD`            |   unset | Own and delegated model spend in US dollars                                                                   |
| `maxTokens`             |   unset | Own prompt and completion tokens; child tokens are not included                                               |
| `maxDurationMs`         |   unset | Wall-clock budget with model warnings before termination                                                      |

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

Both values are fractions of the effective model context window. Jazz requires `warnThresholdRatio < compactThresholdRatio < 0.95`; invalid values are reported and the defaults apply. See [Long-running work](../features/long-running-work.md).

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

Local telemetry is enabled by default. The `telemetry` object controls retention and buffering. An OTLP/HTTP endpoint enables traces by default; set `telemetry.otlp.signals` to add logs or metrics. `telemetry.otlp.metricsEndpoint` accepts a full metrics URL, including Prometheus's `/api/v1/otlp/v1/metrics` path. `maxQueuedBytes` and `maxQueueAgeMs` bound the pending trace/log outbox; `metricExportIntervalMs` controls periodic metrics export. Shared telemetry events contain no prompt, completion, or tool content, and `captureContent` currently has no effect. See [Observability](./observability.md) for backend setup, metric names, privacy, and delivery behavior.

## Secrets and environment variables

Provider and integration keys should be set through Jazz so it can use the system keyring, or supplied as documented environment variables. Run `jazz config show` to inspect resolved non-secret settings.

Common process-wide overrides include:

- `JAZZ_HOME`: data directory, normally `~/.jazz`;
- `JAZZ_CONFIG_PATH`: replacement global config file;
- `JAZZ_OUTPUT_MODE`: terminal output mode;
- `JAZZ_OFFLINE`: disable network-dependent catalog and update behavior;
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`: outbound proxy configuration;
- `OTEL_*`: OpenTelemetry exporter configuration.

Provider-specific keys and endpoints are listed in [Model providers](./providers.md).
