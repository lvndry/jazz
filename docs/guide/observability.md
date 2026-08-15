# Observability

Jazz records every run locally and can push the same events to an OpenTelemetry collector you
already operate. This matters most for the "agent running on a server you own" case, where the
local NDJSON file is not where you go to look.

## What Jazz records

Each run emits:

| Event | When |
| --- | --- |
| `agent_run_started` / `agent_run_completed` | Once per run — a run emits exactly one terminal event |
| `agent_run_failed` | Instead of `completed` when the run dies |
| `llm_usage` | Per LLM request, with token usage and duration |
| `llm_retry` | Per failed LLM attempt |
| `tool_invocation` / `tool_error` | Per tool call, with duration |
| `command_executed` | Per CLI command, with the command path only |

They land in `~/.jazz/telemetry/events/YYYY-MM-DD.ndjson` and are pruned after
`telemetry.retentionDays` (90 by default). This happens whether or not you export anywhere.

## Exporting to a collector

Point Jazz at any OTLP/HTTP endpoint:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

That is the whole setup — an endpoint alone turns export on. To try it end to end, run a
collector that prints what it receives:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector
```

Then run any agent and watch the events arrive. To configure it persistently instead of by
environment, use `telemetry.otlp` in `~/.jazz/config.json` — see
[Configuration](../reference/configuration.md#telemetry).

## Signals: traces and logs

Jazz exports **traces** by default. Spans are what turn a run into a waterfall, and they are
what LLM-observability backends accept — Langfuse ingests OTLP traces and not logs.

Each run becomes one trace: the run is the root span, and every LLM request, retry, and tool
call is a child span under it. Span timings are derived from each event's recorded duration, so
a span is written when the operation *finishes*.

Set `telemetry.otlp.signals` to also (or instead) export log records, for a collector routing
into a log store:

```json
{ "telemetry": { "otlp": { "signals": ["traces", "logs"] } } }
```

**Known limitation:** trace grouping is derived from the run id rather than a span context
threaded through the agent loop, so a subagent run gets its own trace instead of nesting under
the parent run's span. Everything within a single run nests correctly.

## Exporting to Langfuse

Langfuse ingests OTLP traces directly, so it needs no separate integration — just its endpoint
and a Basic auth header built from your key pair:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64)"
```

Self-hosted Langfuse works the same way with your own host in place of `cloud.langfuse.com`.
Do not add `logs` to `signals` for Langfuse — it has no logs endpoint and the requests would
just fail.

Note that `OTEL_EXPORTER_OTLP_HEADERS` values are percent-decoded, per the OpenTelemetry spec.
Base64 padding (`=`) survives fine, but if your header value contains a literal `%` you must
encode it as `%25`.

## Attributes

Spans and log records carry the same attributes. Where the OpenTelemetry GenAI semantic
conventions define one, Jazz uses it:

| Attribute | Value |
| --- | --- |
| `gen_ai.system` | Provider (`anthropic`, `openai`, …) |
| `gen_ai.request.model` / `gen_ai.response.model` | Model id |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | Token counts |

Everything else is namespaced under `jazz.*` — `jazz.agent.id`, `jazz.conversation.id`,
`jazz.run.id`, `jazz.toolName`, `jazz.durationMs`, and the cache and reasoning token counts that
have no semconv equivalent, under `jazz.usage.*`.

These attribute names are still moving upstream. Jazz pins the semconv version it targets in
`src/services/telemetry/otlp-mapping.ts`; treat a rename upstream as a deliberate change.

## Prompts and completions

By default Jazz exports **no** user or model text. Content-bearing fields are dropped and every
remaining string attribute is truncated to 256 characters, so a stack trace or a long tool name
cannot smuggle content out.

Turning this off is deliberate and config-only — there is no environment variable for it:

```json
{ "telemetry": { "otlp": { "captureContent": true } } }
```

Enabling it sends prompts, model output, and tool arguments to whatever endpoint you configured.
Today no event Jazz emits carries content, so the flag changes nothing yet; it exists so that
adding a content-bearing field later cannot leak it by default.

## Failure behavior

Telemetry is best-effort by construction and never fails or slows a run:

- Sinks are written concurrently and independently — a dead collector does not stop the local
  file, and vice versa.
- Failed writes are retried on the next flush, but only when *every* sink failed, so a working
  file sink plus a dead collector never duplicates rows on disk.
- If the collector stays down, the buffer stops growing at ten times `bufferSize` and the oldest
  events are dropped with a warning in the log.
- HTTP failures retry three times with backoff. A `401` or other non-retryable status fails fast
  rather than burning attempts.

## Turning it all off

```json
{ "telemetry": { "enabled": false } }
```

This stops local recording as well as export. To keep local files but stop exporting, set
`telemetry.otlp.enabled` to `false` — the endpoint stays configured.
