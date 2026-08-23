# Configuration Reference

Jazz is configured via configuration files and environment variables.

## Configuration File Locations

Jazz loads configuration from two layers:

1. **`~/.jazz/config.json`** — Global config (agents, API keys, defaults). All writes go here.
2. **`./.jazz/config.json`** — Optional project-local overrides (like `.claude/`). Read-only merge on top of global.

Merge order: defaults → `~/.jazz/config.json` → `./.jazz/config.json`.

Agents and storage always live in the Jazz home directory (`~/.jazz` or `JAZZ_HOME`), even when project overrides exist.

You can replace the global config path with `$JAZZ_CONFIG_PATH` or `--config`. Project-local `./.jazz/config.json` still merges on top.

Legacy `./jazz.config.json` in the project root is no longer discovered automatically. Move settings to `~/.jazz/config.json`.

## MCP Servers: `.agents/mcp.json`

Jazz also loads MCP servers from the `.agents` convention paths. These are merged with the main config (project overrides user):

- `~/.agents/mcp.json` — User-level MCP config
- `./.agents/mcp.json` — Project-level MCP config

See [MCP Servers](../integrations/index.md#mcp-servers) for format details.

## Main Config: `~/.jazz/config.json`

```json
{
  "defaultModel": "anthropic:claude-3-5-sonnet",
  "theme": "dark",
  "notifications": true,
  "autoUpdate": true,
  "logLevel": "info"
}
```

### `maxIterations` and `maxSubagentIterations`

Iteration budgets — how many reasoning loops a run gets before it stops and asks whether to
continue.

```json
{
  "maxIterations": 100,
  "maxSubagentIterations": 30
}
```

| Key                     | Default | Applies to         |
| ----------------------- | ------- | ------------------ |
| `maxIterations`         | 100     | A top-level run    |
| `maxSubagentIterations` | 30      | Each sub-agent run |

They are **separate knobs on purpose.** A sub-agent gets its own budget rather than the parent's
remainder — a child spawned on the parent's last iteration would be useless with one round — so
without a lower default, every level of delegation would be as expensive as the run that spawned
it. A sub-agent answers one scoped task; a child still working after 30 iterations has usually
misunderstood the brief rather than found more to do.

An explicit `--max-iterations` on the command line, or a workflow's own `maxIterations`, still
wins over `maxIterations` here. Both values are floored at 1.

### `maxSubagentDepth`

How many levels of sub-agent may nest below a top-level run. Defaults to **3**.

```json
{
  "maxSubagentDepth": 3
}
```

Each level of delegation gets a *fresh* iteration budget rather than its parent's remainder — a
child spawned on the parent's last iteration would be useless otherwise — so this depth, not the
parent's remaining budget, is what bounds how much a nest of sub-agents can spend. Past the
limit `spawn_subagent` returns an error telling the agent to do the work itself; it never
silently runs the child anyway. Set `0` to stop agents delegating at all. See
[Sub-agents](../internals/subagents.md#nesting-depth).

### `context`

When to warn the model that its context is filling, and when to compact history automatically. Both are fractions of the run's context budget — the effective model window, after any `numCtx` pin or agent `maxContextTokens` ceiling.

```json
{
  "context": {
    "warnThresholdRatio": 0.7,
    "compactThresholdRatio": 0.8
  }
}
```

| Key                     | Default | Effect                                                                 |
| ----------------------- | ------- | ---------------------------------------------------------------------- |
| `warnThresholdRatio`    | 0.7     | The model is told to consolidate what it has while detail still exists |
| `compactThresholdRatio` | 0.8     | Older history is summarized automatically                              |

The ordering `warn < compact < 0.95` is enforced. The 0.95 ceiling is the trim ratio: trimming *discards* messages rather than summarizing them, so a compaction threshold at or above it would let trimming pre-empt compaction and turn the whole scheme into a sliding window. A value that breaks the ordering — or that isn't a number strictly between 0 and 1 — is ignored with a logged warning and the default is used; the run never fails on a bad ratio.

Raising `compactThresholdRatio` keeps more verbatim history but leaves less headroom, which bites hardest on local servers whose real window is smaller than advertised. Lowering it compacts earlier and more often, costing a summarizer call each time. The reserved-space figure in `/context` is derived from this setting, so the grid always reflects where compaction actually fires.

### `output`

Terminal display of reasoning, tools, and formatting. The interactive TUI reads these when a session starts.

```json
{
  "output": {
    "showReasoning": true,
    "collapseReasoning": true,
    "showToolExecution": true,
    "mode": "hybrid"
  }
}
```

| Key                  | Default | Effect                                                                                          |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `showReasoning`      | `true`  | Stream the model's reasoning while it thinks                                                    |
| `collapseReasoning`  | `true`  | After thinking finishes, collapse it to a one-line summary. **Ctrl+R** expands it in place      |
| `showToolExecution`  | `true`  | Show tool calls as they run                                                                     |
| `mode`               | `hybrid` | `rendered` \| `hybrid` \| `raw` \| `quiet`. Overridable with `JAZZ_OUTPUT_MODE` / `--output` |

Set `collapseReasoning` to `false` to leave the full reasoning visible after it finishes. Ctrl+R is then unused — there is nothing collapsed to expand. Change it with `jazz config set output.collapseReasoning false`, or from **Output & Display** in `jazz config`.

## Project Overrides: `./.jazz/config.json`

Use for project-specific settings such as MCP enable/disable flags or logging level. Do not put agent storage paths here — agents always load from `~/.jazz`.

## Environment Variables

Override settings or provide API keys via `.env` or the process environment.

### Paths and data

| Variable           | Effect                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_HOME`        | Jazz home directory (default `~/.jazz`). Holds agents, history, logs, telemetry, and the model-catalog snapshot. Use it to isolate test data when developing Jazz |
| `JAZZ_CONFIG_PATH` | Global config file path (same as `--config`)                                                                                                                      |
| `JAZZ_LOG_DIR`     | Log directory override                                                                                                                                            |

### Network behavior

| Variable                     | Effect                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_OFFLINE`               | `1`/`true`: make no outbound request of Jazz's own — skips the update check *and* the models.dev catalog fetch. See [Airgapped](../guide/airgapped.md)                                |
| `JAZZ_DISABLE_UPDATE_CHECK`  | `1`: skip only the npm version check                                                                                                                                                  |
| `JAZZ_MODELS_DEV_URL`        | Point the model catalog at an internal mirror of `https://models.dev/api.json`                                                                                                        |
| `HTTPS_PROXY` / `HTTP_PROXY` | Send every outbound request — provider APIs, web tools, remote MCP servers, the update check — through an HTTP proxy. Lowercase names work too, and `ALL_PROXY` covers both protocols |
| `NO_PROXY`                   | Comma-separated hosts and domain suffixes to reach directly, bypassing the proxy                                                                                                      |

Only `http://` and `https://` proxies are supported; a SOCKS proxy is reported at
startup rather than silently ignored. If the proxy terminates TLS with a private
CA, point Node at that CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

### Providers

| Variable                       | Effect                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`               | OpenAI                                                                                   |
| `ANTHROPIC_API_KEY`            | Anthropic                                                                                |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini                                                                            |
| `OPENROUTER_API_KEY`           | OpenRouter                                                                               |
| `OLLAMA_BASE_URL`              | Ollama endpoint (default `http://localhost:11434/api`; `/api` is appended automatically) |
| `LLAMACPP_BASE_URL`            | llama.cpp endpoint (default `http://localhost:8080/v1`)                                  |

Other providers follow the same `<PROVIDER>_API_KEY` convention — see
[Integrations → Providers](../integrations/providers.md).

### Output and terminal

| Variable           | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `JAZZ_NO_TUI`      | `1`: no terminal UI at all, plain output (same as `--no-tui`)                |
| `JAZZ_FULLSCREEN`  | `0`: keep an interactive interface but not the alternate screen. Print-and-exit commands never enter it, so their output stays in scrollback. |
| `JAZZ_OUTPUT_MODE` | `rendered` \| `hybrid` \| `raw` \| `quiet` (same as `--output`)              |
| `JAZZ_THEME`       | Colour theme                                                                 |
| `JAZZ_UI_GLYPHS`   | `unicode` \| `ascii` — override glyph detection for terminals that misreport |
| `JAZZ_TABLE_STYLE` | Table rendering style                                                        |
| `NO_COLOR`         | Standard: disable colour output                                              |

### Scheduling

| Variable                | Effect                                            |
| ----------------------- | ------------------------------------------------- |
| `JAZZ_DISABLE_CATCH_UP` | `1`: never offer missed scheduled runs on startup |

### Notifications

| Variable                                       | Effect                                                         |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `JAZZ_TERMINAL_NOTIFIER` / `TERMINAL_NOTIFIER` | Path to a `terminal-notifier` binary for desktop notifications |
| `JAZZ_TERMINAL`                                | Terminal identity used for notification attribution            |

## `telemetry`

Jazz records what each run did — agent runs, LLM requests and token usage, retries, tool
invocations, and CLI commands — as NDJSON under `~/.jazz/telemetry/events/YYYY-MM-DD.ndjson`,
pruned after `retentionDays`. Set `telemetry.otlp` to also push those events to an
OpenTelemetry collector. See [Observability](../guide/observability.md) for a working
collector and Langfuse setup.

```json
{
  "telemetry": {
    "enabled": true,
    "retentionDays": 90,
    "otlp": {
      "endpoint": "http://localhost:4318",
      "headers": { "authorization": "Basic <base64>" },
      "serviceName": "jazz",
      "captureContent": false
    }
  }
}
```

| Field                 | Default                        | Effect                                                       |
| --------------------- | ------------------------------ | ------------------------------------------------------------ |
| `enabled`             | `true`                         | Master switch. `false` records nothing, locally or remotely  |
| `storagePath`         | `~/.jazz/telemetry`            | Where the local NDJSON files live                            |
| `bufferSize`          | `100`                          | Events buffered in memory before a flush                     |
| `flushIntervalMs`     | `30000`                        | Periodic flush interval                                      |
| `retentionDays`       | `90`                           | Local files older than this are deleted                      |
| `otlp.enabled`        | `true` when an endpoint is set | Explicit opt-out that keeps the endpoint configured          |
| `otlp.signals`        | `["traces"]`                   | Signals to export: `traces`, `logs`, or both                 |
| `otlp.endpoint`       | —                              | Collector base URL; `/v1/traces` and `/v1/logs` are appended |
| `otlp.tracesEndpoint` | —                              | Full traces URL including path, overriding `endpoint`        |
| `otlp.logsEndpoint`   | —                              | Full logs URL including path, overriding `endpoint`          |
| `otlp.headers`        | `{}`                           | Extra HTTP headers, typically auth                           |
| `otlp.serviceName`    | `jazz`                         | `service.name` on exported records                           |
| `otlp.captureContent` | `false`                        | Include prompt, completion, and tool argument text           |
| `otlp.timeoutMs`      | `10000`                        | Per-request timeout                                          |

### OTLP environment variables

Every `otlp` field falls back to the standard `OTEL_*` variable, so a Jazz process inherits an
already-configured collector without touching `config.json`. Precedence is config → environment
→ default.

| Variable                             | Effect                                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Collector base URL. Setting this alone turns export on     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, used verbatim; wins over the base URL     |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`   | Full logs URL, used verbatim; wins over the base URL       |
| `OTEL_EXPORTER_OTLP_HEADERS`         | `key=value` pairs, comma-separated, values percent-encoded |
| `OTEL_SERVICE_NAME`                  | `service.name` on exported records                         |

There is no environment variable for `captureContent` — it can only be turned on in config, and
never follows from configuring an endpoint.

### What gets exported

Events are sent over OTLP/HTTP with JSON encoding. By default they are exported as **traces**:
one trace per agent run, with the run as the root span and each LLM request, retry, and tool
call as a child span. Traces are what LLM-observability backends accept — Langfuse ingests OTLP
traces and not logs — so this is the signal that works everywhere. Add `logs` to
`otlp.signals` to also emit the same events as OTLP log records.

Where the OpenTelemetry GenAI semantic conventions define an attribute, Jazz uses it
(`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`); everything else is namespaced under `jazz.*`.

**`captureContent` is the one setting that turns observability into data egress.** With it off
(the default) Jazz drops content-bearing fields and truncates every remaining string attribute
to 256 characters. Turning it on sends user prompts, model output, and tool arguments to
whatever endpoint you configured. No event Jazz emits today carries content, so the flag is
currently inert — it exists so that adding a content-bearing field later cannot leak it by
default.

Export never blocks a run. A collector that is slow, down, or rejecting is logged as a warning
and the events are dropped once the buffer ceiling is reached; the local NDJSON file is
unaffected.

## `autoApprovedCommands`

A persisted allowlist for `execute_command`, set at the top level of `~/.jazz/config.json`:

```json
{ "autoApprovedCommands": ["himalaya", "khal", "git status"] }
```

Each entry lets one command through **without** raising the whole approval tier. This is the
right tool when a scheduled workflow needs a skill that shells out — email, calendar, and
Obsidian all run through `execute_command`, which is `unknown`, so a `low-risk` workflow
cannot use them otherwise.

Matching uses a parsed key (binary + first subcommand) with exact or word-boundary
comparison, never a raw string prefix — so `git status` does not also permit
`git status && rm -rf /`. See
[Tools & approval](../internals/tools-and-approval.md#two-sharper-controls).

## Agent Config: `customTools`

`customTools` is an optional field on an agent's `config`, letting a deployment declare new
tools directly in the agent's JSON config instead of shipping code — the closest analog is the
Claude Agent SDK's custom tools (name, description, input schema, handler, registered alongside
builtins). Declaring a custom tool is not enough to expose it: its `name` must also appear in
the agent's `tools` array, exactly like a builtin or MCP tool. A declared-but-unlisted custom
tool is simply skipped at registration.

Each entry has a `handler.type` of either `record` or `command`.

**`record`** — no side effect. The call is validated and appended to the run's `toolCalls` (the
same field every other tool call surfaces in), so the *caller* embedding Jazz can read the
arguments and act on them; the model itself only ever sees the fixed `response`. Note that
`toolCalls` reports calls as the model sent them — including calls whose arguments failed schema
validation — so callers must re-validate arguments before acting on them. This is the
pattern behind confirmation-card / propose-then-confirm flows:

```json
{
  "name": "propose_action",
  "description": "Propose an action for the user to confirm before it is carried out.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "description": "Short description of the proposed action" },
      "payload": { "type": "object", "description": "Structured data needed to carry out the action" }
    },
    "required": ["action"]
  },
  "handler": {
    "type": "record",
    "response": "Proposal recorded — the user will see a confirmation card."
  }
}
```

**`command`** — spawns `handler.command` directly (an argv array, no shell) with the validated
tool arguments serialized as JSON on the child's stdin. Exit code `0` returns stdout (capped at
16 KB — tighter than `execute_command`'s 256 KB, because custom commands are small trusted argv
programs, not a general shell) as the tool result; a non-zero exit, spawn error, or timeout produces a failure result the
model sees the same way it sees a failing builtin tool. The command's environment is sanitized
the same way `execute_command` sanitizes its shell environment (see `envAllowlist` below), using
the `envAllowlist` of the agent that DECLARED the tool, not whichever agent happens to be calling
it. **Security note:** command tools execute with no interactive approval step — they are always
registered `high-risk` and run whatever the deployment configured the moment the model calls
them, so treat `handler.command` entries as deployment-authored, trusted commands, not
user-supplied ones.

```json
{
  "name": "lint_project",
  "description": "Run the project linter",
  "parameters": {
    "type": "object",
    "properties": {}
  },
  "handler": {
    "type": "command",
    "command": ["./lint.sh"],
    "timeoutMs": 30000
  }
}
```

`timeoutMs` defaults to 30 000 ms and is capped at 300 000 ms (5 minutes) when set.

### Validation rules

- `name`: must match `^[a-z][a-z0-9_]{1,63}$`, must be unique within `customTools`, and must not
  start with the `mcp_` prefix (reserved for MCP-sourced tools).
- At most 16 entries per agent.
- `description`: 1-1024 characters — this is what the model reads to decide when to call the tool.
- `parameters`: a JSON Schema object; must have `"type": "object"`. Only a subset of JSON Schema
  is honored by the converter that turns this into the runtime validator: unsupported keywords
  are silently dropped, and a property with a missing or unrecognized `type` degrades to an
  empty object schema — which then rejects a scalar argument (string/number/boolean) passed for
  that property. Stick to `string`, `number`, `integer`, `boolean`, `null`, `enum`, and plain
  nested objects/arrays of those.
- `handler.response` (record): optional string, at most 1024 characters, defaults to `"Recorded."`.
- `handler.command` (command): a non-empty array of non-empty strings.

### Collisions and re-registration

A custom tool name that collides with an already-registered builtin or MCP tool name — or one of
its aliases (e.g. `glob`) — fails the run with a configuration error rather than silently
overriding the existing tool; rename the custom tool or remove the conflicting one. Because tool
registration runs on every agent run (not just once per process), re-registering the *exact
same* custom tool definition under a name that's already registered is a no-op, not a collision;
only a genuinely different definition sharing that name is rejected — and since the registry has
no way to update an existing registration in place, that rejection fails the run MID-SESSION
(not at process startup): restart the session, or revert the custom tool definition to match
what was registered earlier.

## Agent Config: `envAllowlist`

`envAllowlist` is an optional `string[]` field on an agent's `config` that exempts specific
environment variable names from the sensitive-name scrub applied to shell commands the agent
runs (`execute_command` and custom `command`-handler tools share this same env-sanitization
path; it does not affect `grep`/`find`/`git` tool spawns). By default, any variable whose name
matches `API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` (case-insensitive) is stripped before a
child process is spawned. Listing a name in `envAllowlist` copies that variable from the
process environment into the child's environment even though it matches the scrub regex — it
never invents a value that isn't already set. `SSH_*`-prefixed names and the small set of base
env vars Jazz always sets itself (`PATH`, `HOME`, `USER`, `SHELL`, etc.) can never be
allowlisted — that block applies unconditionally, regardless of `envAllowlist` membership.

```json
{
  "envAllowlist": ["MY_SERVICE_TOKEN"]
}
```

Validation: at most 32 names, each matching `^[A-Z][A-Z0-9_]{0,63}$` (uppercase letters,
digits, and underscores, starting with a letter, up to 64 characters).

**Security note:** allowlisting a secret-bearing variable hands it to every shell command the
agent runs — the deployment owns that trade-off.

---

## Agent Config: `temperature`

`temperature` is an optional `number` field on an agent's `config` that sets the model's
sampling temperature. The wizard never asks for it, so it is a file-only setting:

```json
{
  "config": {
    "llmProvider": "anthropic",
    "llmModel": "claude-sonnet-4-5",
    "temperature": 0.2
  }
}
```

**Leaving it unset is not the same as setting a default.** When the field is absent Jazz omits
the parameter from the request entirely and the provider applies its own default. Set it only
when you want to override that.

Jazz does not range-check the value — the valid range differs by provider (commonly `0`–`1` or
`0`–`2`), and an out-of-range number surfaces as a provider error.

**Models that reject a custom temperature silently ignore this field.** Some models — notably
several reasoning models — accept no temperature at all. Jazz reads that capability from
[models.dev](https://models.dev) metadata (and, for OpenRouter, the model's
`supported_parameters`), and drops the parameter rather than sending a request the provider
would reject. The agent still runs; the setting simply has no effect. If a temperature change
appears to do nothing, that is the first thing to check.
