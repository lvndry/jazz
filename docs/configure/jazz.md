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

`jazz config set` stores a value with the type the setting is read back as: `jazz config set maxRetries 5` stores the number `5`, and `jazz config set output.collapseReasoning false` stores the boolean `false`. Text settings such as API keys, paths, `logging.level`, and `llm.ollama.keep_alive` are stored as typed. A value that cannot be read as the setting's type is refused instead of written:

```console
$ jazz config set maxRetries never
❌ Configuration Validation Error
   Field "maxRetries" expected a whole number, got never

💡 Suggestion: Pass a plain whole number, with no units or quotes — 600000, not 600000ms.
```

It also refuses a key Jazz does not read, suggesting the one a typo most likely meant (`maxRetrys` → `maxRetries`). Lists such as `peers` and `webhooks` are not set one field at a time; use `jazz peers` and `jazz webhook`, or edit the file.

Omit `<value>` to enter it at a prompt. For a per-entry secret such as `notify.targets.phone.botToken`, Jazz reports when the value could not be stored because no keyring is available, whether it came from the prompt or the command line. In that case, supply the named environment variable wherever the daemon runs instead; a success message means the secret was stored.

A write changes only the key you set, and only in the global file. Values merged in from a project file, from `--debug`, from environment variables, or from the keyring are never copied into it. Unknown or invalid entries remain untouched, but Jazz refuses to overwrite malformed JSON.

## Mistakes in a configuration file

Jazz checks each configuration file before it can affect runtime behavior. A value of the wrong type, an unknown key, an invalid safety invariant, or malformed JSON stops every command with exit code `1` and names each problem, rather than running on defaults that could quietly drop your limits and approvals. A `--config` path that does not exist stops the command the same way:

```console
jazz: invalid configuration in /home/you/.jazz/config.json (2 entries):
  maxRetries: expected a whole number of 0 or more, got "5"
  maxRetrys: not a setting — did you mean maxRetries?
```

Run `jazz config validate` for the same diagnostics and a non-zero exit status, even on a broken file. It also checks every agent file (see [`jazz config`](../commands.md#jazz-config)). A daemon that notices an invalid live edit keeps serving its last-known-good configuration and reports the problem; once the file is repaired, a later reload adopts it. A value found where a secret belongs is described by its type and never printed.

## Run budgets

| Key                     | Default | Meaning                                                                                                       |
| ----------------------- | ------: | ------------------------------------------------------------------------------------------------------------- |
| `maxIterations`         |   `100` | Reason-and-act cycles for a top-level run                                                                     |
| `maxSubagentIterations` |    `30` | Reason-and-act cycles for each delegated child run                                                            |
| `maxSubagentDepth`      |     `3` | Delegation levels below the top-level run; `0` disables delegation                                            |
| `maxRetries`            |    `10` | Retries per model call after transient provider failures, shared by streaming and its fallback                |
| `editor`                |         | Editor for `jazz persona edit` / `jazz mcp add`, e.g. `code --wait`; falls back to `$VISUAL`, `$EDITOR`, `vi` |
| `maxCostUSD`            |   unset | Own and delegated model spend in US dollars                                                                   |
| `maxTokens`             |   unset | Own prompt and completion tokens; child tokens are not included                                               |
| `maxDurationMs`         |   unset | Wall-clock budget with model warnings before termination                                                      |

Cost and token limits are checked between iterations. One model call or tool phase can cross them before Jazz stops the next iteration. The duration limit is a deadline: when it passes, Jazz interrupts whatever is running (a model call, a shell command, a sub-agent), closes any unfinished tool call, and returns what the run had so far. Sub-agents run under what is left of it. An external `--timeout` is a separate hard deadline around the entire run that ends it as a failure.

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

Both values are fractions of the effective model context window. Jazz requires `warnThresholdRatio < compactThresholdRatio < 0.95`; invalid values stop startup with a validation error. See [Context management](../concepts/context-management.md).

## Logs and history retention

| Key                                | Default | Meaning                                                                                  |
| ---------------------------------- | ------: | ---------------------------------------------------------------------------------------- |
| `logging.retentionDays`            |    `14` | Days a file in `~/.jazz/logs/` is kept after its last write                              |
| `logging.maxTotalSizeMB`           |   `200` | Size cap for `~/.jazz/logs/`; the least recently written files are deleted first         |
| `history.maxConversationsPerAgent` |   `100` | Conversations each agent keeps in its live history; older ones are archived, not deleted |

Individual log files also rotate at 10 MB. Conversations a goal, loop or run still uses are never
archived. See [sizes and retention](../runtime-data/index.md#sizes-and-retention) for everything
Jazz keeps on disk and how each part is bounded.

## Output and notifications

`output.mode` accepts `rendered`, `hybrid`, `raw`, or `quiet`. `JAZZ_OUTPUT_MODE` and `--output` override it. The other output fields control whether reasoning and tool execution are shown and whether completed reasoning collapses.

`notifications.enabled` and `notifications.sound` control desktop completion and approval notifications; `enabled: false` also drops desktop [notify targets](./notifications.md).

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

`webhooks` defines authenticated, fixed-prompt HTTP doors served by `jazz daemon`. Each entry names an agent and may narrow conversation persistence, disclosure, and allowed tools. `signature` (`{ "format": "hmac-sha256", "header"?, "prefix"? }`) authenticates by a signature over the body instead of a bearer token, and `deliveryIdHeader` names the header a repeated delivery is recognized by. Manage the bearer token and signing secret with `jazz webhook`, not in JSON. [Wake an agent from another system with a webhook](../guides/webhook-endpoint.md) has a complete entry and the request that fires it.

`peers` lists remote Jazz agents this installation has explicitly chosen to trust. Peer credentials belong in the keyring. See [Agent-to-agent](../concepts/agent-to-agent.md).

Both take the same per-door limits:

| Key                    | Meaning                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `budget.maxTokens`     | Token cap on each run the door starts. Falls back to the top-level `maxTokens`                       |
| `budget.maxCostUSD`    | Cost cap on each run. Falls back to the top-level `maxCostUSD`                                       |
| `budget.maxDurationMs` | Wall-clock cap on each run. Falls back to the top-level `maxDurationMs`                              |
| `maxConcurrentRuns`    | Runs the door may have in flight at once, default 4. A request past it gets `429` with `Retry-After` |

Two entries in one list whose names differ only in case or punctuation (`a.b` and `A_b`) read the same credential environment variable, so the second is refused when the config loads.

## Spend caps and notifications

```json
{
  "daemon": {
    "dailyCostUSD": 3,
    "dailyTokens": 2000000,
    "monthlyCostUSD": 40,
    "goals": { "dailyCostUSD": 1, "monthlyCostUSD": 15 },
    "agents": { "inbox": { "dailyCostUSD": 0.5 } }
  },
  "notify": {
    "targets": [
      { "name": "desktop", "kind": "desktop" },
      { "name": "phone", "kind": "ntfy", "url": "https://ntfy.sh/my-private-jazz-topic" },
      { "name": "ops", "kind": "webhook", "url": "https://example.com/jazz-hook" }
    ]
  }
}
```

The `daemon` caps bound what unattended runs (the daemon's work, `jazz run`, workflows, webhooks, peers, goals, loops and triggers) may spend, counted from the machine-wide spend ledger. Your chat turns never count. Every cap is unset, meaning unlimited, until you set it. Reaching `dailyCostUSD` or `dailyTokens` pauses `jazz daemon` until local midnight (`jazz daemon resume` lifts it for the rest of the day), and any reached cap refuses the unattended runs it covers before they start. A daily dollar cap with an unpriced unattended run today counts as reached. `goals` covers goal cycles and loop runs; `agents.<agent>` covers one agent, keyed by its name or id. See [daily and monthly caps](../concepts/budgets.md#daily-and-monthly-caps).

`notify.targets` is where Jazz tells you something needs you, that the daemon paused, that unattended work failed or hit a cap, a reminder a desktop could not show, and a workflow's result. Unset, it is one desktop target. Kinds are `desktop`, `ntfy`, `webhook`, `telegram` and `discord`; secrets live in the keyring. Pick an ntfy topic name nobody can guess: anyone who knows it can read what you are sent. See [Notifications](./notifications.md).

## Private network hosts

Other URL tools (`read_pdf`, and pages rendered by
`create_pdf` and `create_composition`) reach public internet hosts directly. A URL that reaches
this machine or your local network (loopback, private, link-local including the cloud metadata
address `169.254.169.254`, CGNAT and other non-public addresses) stops for your approval first,
like any gated call: a prompt in chat, a parked run when you are away, a decline when nobody can
answer. Approving adds the address to `network.allowPrivateHosts`, so the next request to it goes
through without asking. A `high-risk` or yolo run reaches it without asking and leaves the list
as it is.

`network.allowPrivateHosts` applies to every agent and is read from the global config file only;
a project `./.jazz/config.json` cannot widen it. Edit it from `jazz` → `/settings` →
**Private network hosts**, or in the file, at most 64 entries:

```json
{
  "network": { "allowPrivateHosts": ["homeassistant.local", "*.lan", "192.168.1.10", "10.0.0.0/8"] }
}
```

| Entry                 | Allows                                         |
| --------------------- | ---------------------------------------------- |
| `homeassistant.local` | that hostname, whatever address it resolves to |
| `*.lan`               | every name ending in `.lan`                    |
| `192.168.1.10`, `::1` | that address, reached by IP or by any hostname |
| `192.168.1.0/24`      | every address in the block                     |

These settings apply to other URL tools, such as `read_pdf` and rendered pages.
HTTP requests and web fetches use the independent HTTP policy below.

Use a hostname entry for a name you control, and an address or block entry for a device with a
fixed address. Approvals add the address the request reached. A redirect or a page subresource
that lands on an unlisted private address is refused rather than asked about; the model can
request that URL directly, which asks you. See
[secrets and egress](../security/secrets-and-egress.md#network-egress) for what the guard checks.

## Web request safety

HTTP requests (`http_request`) and page fetches (`web_fetch`) run automatically by default,
including requests to private destinations and requests made after reading untrusted content.
This is independent of the run's approval tier and applies to unattended runs too. These tools
can send data in URLs, headers or bodies; enable a URL allowlist when you want to approve requests.

Enable approval for requests outside a URL allowlist by adding grants to the global config file:

```json
{
  "network": {
    "httpApproval": ["https://api.example.com/status", "https://docs.example.com/reference/*"]
  }
}
```

Exact URLs include their query string. A trailing `/*` grants paths below that prefix on the
same origin, including queries; host wildcards and other wildcard forms are unsupported. An
empty array asks for every request. Requests outside the list ask for one-call approval, or park
when the run is unattended. Approving a request never adds it to the list. Redirect destinations
must also match a permanent grant or the exact URL approved for that call; otherwise the tool
returns a refusal and can request that URL directly. Cross-origin redirects strip credentials
and do not resend request bodies. Set `network.httpApproval` to `"allow"`, or remove it, to
restore automatic requests. Project config cannot widen these grants.

Other egress tools keep their own approval rules, including taint checks after untrusted content
and private-destination guards. `network.allowPrivateHosts` controls their private-network reach.

## MCP overrides

Full MCP server definitions live in `~/.agents/mcp.json` or `./.agents/mcp.json`. Jazz stores only per-server `enabled` and `trusted` overrides in `config.json`. `trusted` is read from the global file only, and applies only to servers defined in `~/.agents/mcp.json`; a project file's `trusted` is ignored with a warning. See [MCP](./mcp.md#trust-controls-approval-not-identity).

## Telemetry

Local telemetry is enabled by default. The `telemetry` object controls retention and buffering. An OTLP/HTTP endpoint enables traces by default; set `telemetry.otlp.signals` to add logs or metrics. `telemetry.otlp.metricsEndpoint` accepts a full metrics URL, including Prometheus's `/api/v1/otlp/v1/metrics` path. `maxQueuedBytes` and `maxQueueAgeMs` bound the pending trace/log outbox; `metricExportIntervalMs` controls periodic metrics export. Telemetry events carry no prompt, completion, or tool content, so nothing you configure sends conversation text to a collector. See [Observability](./observability.md) for backend setup, metric names, privacy, and delivery behavior.

## Secrets and environment variables

Provider and integration keys should be set through Jazz so it can use the system keyring, or supplied as documented environment variables. Run `jazz config show` to inspect the resolved settings; secrets are redacted unless you pass `--reveal`.

Common process-wide overrides include:

- `JAZZ_HOME`: data directory, normally `~/.jazz`;
- `JAZZ_CONFIG_PATH`: replacement global config file;
- `JAZZ_OUTPUT_MODE`: terminal output mode;
- `JAZZ_OFFLINE`: disable network-dependent catalog and update behavior;
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`: outbound proxy configuration;
- `OTEL_*`: OpenTelemetry exporter configuration.

Provider-specific keys and endpoints are listed in [Model providers](./providers.md).
