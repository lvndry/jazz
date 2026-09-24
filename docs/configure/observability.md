---
description: "Use Jazz's local audit trail and OTLP traces, logs, and metrics with a collector, SigNoz, Datadog, Prometheus, or Langfuse."
---

# Observability

Jazz writes a local audit trail for every run. When you configure an OTLP endpoint, it also exports selected OpenTelemetry signals. The default is traces only. OTLP uses HTTP: traces and logs are JSON, and metrics are protobuf.

## Local records and signals

Local telemetry events are NDJSON under `~/.jazz/telemetry/events/YYYY-MM-DD.ndjson`, retained for 90 days by default. Operational logs live under `~/.jazz/logs/`. The local event stream includes run start and terminal state, LLM usage and retries, tool outcomes, periodic process samples, and CLI command completion. It is recorded even when no OTLP endpoint is configured.

| OTLP signal | What Jazz sends                                                                                                    | Typical use                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Traces      | One trace per top-level run, with child LLM, retry, and tool spans; internal subagent runs join their parent trace | Latency, model and tool waterfalls, Langfuse            |
| Logs        | Structured telemetry events with severity and trace context where available                                        | Event search and trace correlation in SigNoz or Datadog |
| Metrics     | Counters, duration histograms, and process measurements                                                            | Dashboards and alerts in Prometheus, SigNoz, or Datadog |

OTLP logs are telemetry event records. They are separate from the local operational log file. Routine tool diagnostics at INFO level contain IDs, outcomes, and durations, not command text, arguments, results, or error messages. Local tool audit records retain a bounded, redacted argument shape; protect `~/.jazz` as sensitive data.

## Configure an OTLP collector

Set a base endpoint to enable export, and select the signals you need:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

```json
{
  "telemetry": {
    "otlp": {
      "signals": ["traces", "logs", "metrics"],
      "serviceName": "jazz"
    }
  }
}
```

The base endpoint gains `/v1/traces`, `/v1/logs`, and `/v1/metrics`. A signal-specific endpoint must include its full path. Config values take precedence over environment variables. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` supply resource identity; set `deployment.environment.name` and `service.version` through resource attributes when useful for filtering. Jazz uses OTLP/HTTP, so point it at an HTTP receiver, normally port 4318.

`telemetry.otlp.signals` defaults to `["traces"]`. With only a signal-specific endpoint, explicitly select that signal. The supported environment overrides are `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and their per-signal `*_HEADERS` forms. Jazz percent-decodes header values. Keep credentials in environment or a secret store rather than committing them in config.

## Backend recipes

### SigNoz

Point Jazz at your SigNoz OTLP/HTTP ingestion endpoint and select all three signals:

```bash
export OTEL_SERVICE_NAME=jazz
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.<region>.signoz.cloud:443
export OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=<your-ingestion-key>
```

For self-hosted SigNoz, use its collector's HTTP endpoint, commonly `http://<collector>:4318`. Search the service name in **Services**, **Logs Explorer**, and **Metrics Explorer**. SigNoz documents the [endpoint and header format](https://signoz.io/docs/ingestion/opentelemetry-environment-variables/). Jazz does not use `OTEL_EXPORTER_OTLP_PROTOCOL`; its transport is fixed as described above.

### Datadog

For production, point Jazz at a local Datadog Agent or OpenTelemetry Collector OTLP/HTTP receiver. Enable the Agent's OTLP HTTP receiver, then set:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Select `["traces", "logs", "metrics"]` in Jazz config. The Datadog Agent accepts traces and metrics when OTLP ingestion is enabled; [OTLP log ingestion needs separate log collection and OTLP log settings](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/). Datadog [recommends Agent or Collector ingestion](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/) for production. Direct cloud intake has signal-specific endpoints and payload limits; use those endpoints only after configuring each signal deliberately.

### Prometheus

Prometheus receives metrics only. Start it with `--web.enable-otlp-receiver`, then configure the full metrics URL and select only metrics:

```json
{
  "telemetry": {
    "otlp": {
      "metricsEndpoint": "http://localhost:9090/api/v1/otlp/v1/metrics",
      "signals": ["metrics"]
    }
  }
}
```

The [Prometheus OTLP receiver](https://prometheus.io/docs/guides/opentelemetry/) is disabled by default. It accepts OTLP/HTTP protobuf at `/api/v1/otlp/v1/metrics`. Send traces and logs to another receiver if needed.

### Langfuse

Langfuse receives traces, not OTLP logs or metrics. Configure its full traces endpoint and Basic authentication:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64),x-langfuse-ingestion-version=4"
export OTEL_RESOURCE_ATTRIBUTES=langfuse.environment=production
```

Keep `signals` at `["traces"]`. Use your region's host or self-hosted host as appropriate. The root run is an agent observation, LLM calls are generation observations, and tool calls are tool observations. A conversation is mapped to the Langfuse session ID on each span; nested subagent runs share the parent trace. Token counts include cache usage when the provider reports it. Langfuse calculates cost from its own model pricing, so check your model's price configuration before relying on cost totals. See [Langfuse's OTLP mapping](https://langfuse.com/integrations/native/opentelemetry).

Langfuse's [best-practices guide](https://langfuse.com/docs/observability/best-practices) recommends one trace per unit of work, a session for the conversation, interleaved generations and tools, and stable observation names. Jazz follows that structure for top-level runs. It does not send input, output, or reasoning text, so content-based evaluators and dataset experiments will see empty fields. The `x-langfuse-ingestion-version=4` header enables current ingestion behavior; validate the resulting trace in a non-production environment if migrating existing Langfuse dashboards or evaluators. The [v4 migration guide](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4) explains the changed mappings. Set `langfuse.environment` as a resource attribute to keep development and production traces separate.

## Trace and metric fields

Jazz uses `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.operation.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and cache or reasoning token attributes when available. `langfuse.observation.type` marks agent, generation, and tool spans. Jazz IDs and additional counters use the `jazz.*` namespace. Dashboard queries using the old `gen_ai.system` field should migrate to `gen_ai.provider.name`.

Metric names and low-cardinality dimensions are:

| Metric                                                             | Unit    | Dimensions                               |
| ------------------------------------------------------------------ | ------- | ---------------------------------------- |
| `jazz.agent.runs`                                                  | count   | agent ID, status                         |
| `jazz.tool.calls`                                                  | count   | canonical tool name, status              |
| `jazz.llm.calls`                                                   | count   | operation, provider, model               |
| `jazz.llm.tokens`                                                  | tokens  | operation, provider, model, input/output |
| `jazz.agent.run.duration`                                          | seconds | agent ID, status                         |
| `jazz.tool.call.duration`                                          | seconds | canonical tool name, status              |
| `gen_ai.client.operation.duration`                                 | seconds | operation, provider, model               |
| `jazz.process.memory.rss` / `jazz.process.memory.heap_used`        | bytes   | process resource                         |
| `jazz.process.cpu.user` / `jazz.process.cpu.system`                | seconds | cumulative CPU time                      |
| `jazz.telemetry.export.failures` / `jazz.telemetry.export.dropped` | count   | signal and bounded reason                |

Metrics use cumulative temporality and a 30-second export interval by default. The service resource includes a process-specific `service.instance.id` unless you set one. Prometheus may normalize dots in metric names to underscores; inspect its target before writing queries.

## Privacy and delivery

Jazz's shared telemetry event stream does not contain prompt, completion, tool argument, or tool result text. String attributes are bounded and known credential-bearing fields are redacted. `captureContent` defaults to false; setting it to true currently does not add content to events or OTLP. This setting is reserved for a future explicit per-destination content path. Never assume an OTLP collector is a private boundary; configure only approved endpoints.

Traces and logs have independent disk-backed queues under `<telemetry.storagePath>/otlp-outbox`. They contain payloads but no authentication headers, use private file permissions, and retry independently of local event files. Queue limits default to 32 MiB and seven days; oldest pending payloads are dropped with a warning when those limits are reached. Retryable HTTP responses (`429`, `502`, `503`, `504`) and network failures get bounded retries, honoring `Retry-After`. Other HTTP failures are dropped with a warning. An OTLP partial-success response is acknowledged and reported, not retried. An ambiguous connection failure may produce a duplicate after retry or restart; consumers should use stable trace/span IDs where possible.

Metrics use the OpenTelemetry SDK's cumulative aggregation and periodic exporter. They are flushed on clean shutdown but are not stored in the disk outbox, so a crash or prolonged outage can lose a metric interval. Logs and telemetry also flush on normal CLI shutdown. Observability failures are best-effort and do not block agent actions.

Set `telemetry.otlp.maxQueuedBytes`, `telemetry.otlp.maxQueueAgeMs`, and `telemetry.otlp.metricExportIntervalMs` to tune delivery. Set `telemetry.otlp.enabled` to false to retain local records without export, or `telemetry.enabled` to false to disable both local telemetry events and OTLP. Operational logs remain governed by logging config.
