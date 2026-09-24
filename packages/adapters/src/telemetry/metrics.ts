/**
 * Records bounded-cardinality Jazz metrics and exports OTLP/HTTP protobuf.
 *
 * The OpenTelemetry SDK owns metric aggregation and cumulative temporality.
 * Measurements are derived once from new Jazz events; replaying an outbox does
 * not add measurements again. Process gauges sample the Jazz process itself.
 */

import { randomUUID } from "node:crypto";
import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import { sampleProcessResources } from "@jazz/core/utils/process-resources";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { ResolvedOtlpConfig } from "./otlp-config";
import type { TelemetrySink } from "./sink";

const DURATION_BOUNDARIES_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];
const MAX_LABEL_LENGTH = 80;

function label(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_LABEL_LENGTH)
    : "unknown";
}

/** Reject tool labels that are not canonical registry-style identifiers. */
function toolLabel(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(value)
    ? value
    : "unknown";
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value / 1000
    : undefined;
}

/**
 * One provider per Jazz process. A distinct instance id makes cumulative
 * metric resets unambiguous after a process restart.
 */
export class OtlpMetricsSink implements TelemetrySink {
  readonly name = "otlp-metrics";
  private readonly provider: MeterProvider;
  private readonly runs;
  private readonly runDuration;
  private readonly toolCalls;
  private readonly toolDuration;
  private readonly llmCalls;
  private readonly llmDuration;
  private readonly llmTokens;
  private readonly exportFailures;
  private readonly exportDropped;

  constructor(
    config: ResolvedOtlpConfig,
    serviceVersion: string,
    onExportError: (error: Error) => void = () => {},
  ) {
    const delegate = new OTLPMetricExporter({
      url: config.metricsEndpoint,
      headers: config.signalHeaders.metrics,
      timeoutMillis: config.timeoutMs,
      temporalityPreference: AggregationTemporality.CUMULATIVE,
    });
    const exporter: PushMetricExporter = {
      export: (metrics, done) =>
        delegate.export(metrics, (result) => {
          if (result.code !== ExportResultCode.SUCCESS) {
            this.recordExportFailure("metrics", "request");
            onExportError(new Error("OTLP metrics export failed"));
          }
          done(result);
        }),
      forceFlush: () => delegate.forceFlush(),
      shutdown: () => delegate.shutdown(),
      selectAggregationTemporality: (instrumentType) =>
        delegate.selectAggregationTemporality(instrumentType),
    };
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: config.metricExportIntervalMs,
      exportTimeoutMillis: Math.min(config.timeoutMs, config.metricExportIntervalMs),
      cardinalityLimits: { default: 500 },
    });
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({
        ...config.resourceAttributes,
        "service.name": config.serviceName,
        "service.version": serviceVersion,
        "service.instance.id": config.resourceAttributes["service.instance.id"] ?? randomUUID(),
      }),
      readers: [reader],
      views: [
        ...[
          "jazz.agent.run.duration",
          "jazz.tool.call.duration",
          "gen_ai.client.operation.duration",
        ].map((instrumentName) => ({
          instrumentName,
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const,
            options: { boundaries: DURATION_BOUNDARIES_SECONDS },
          },
        })),
      ],
    });
    const meter = this.provider.getMeter("jazz", serviceVersion);
    this.runs = meter.createCounter("jazz.agent.runs", { unit: "{run}" });
    this.runDuration = meter.createHistogram("jazz.agent.run.duration", { unit: "s" });
    this.toolCalls = meter.createCounter("jazz.tool.calls", { unit: "{call}" });
    this.toolDuration = meter.createHistogram("jazz.tool.call.duration", { unit: "s" });
    this.llmCalls = meter.createCounter("jazz.llm.calls", { unit: "{call}" });
    this.llmDuration = meter.createHistogram("gen_ai.client.operation.duration", { unit: "s" });
    this.llmTokens = meter.createCounter("jazz.llm.tokens", { unit: "{token}" });
    this.exportFailures = meter.createCounter("jazz.telemetry.export.failures", {
      unit: "{failure}",
    });
    this.exportDropped = meter.createCounter("jazz.telemetry.export.dropped", {
      unit: "{request}",
    });

    const rss = meter.createObservableGauge("jazz.process.memory.rss", { unit: "By" });
    const heap = meter.createObservableGauge("jazz.process.memory.heap_used", { unit: "By" });
    const cpuUser = meter.createObservableCounter("jazz.process.cpu.user", { unit: "s" });
    const cpuSystem = meter.createObservableCounter("jazz.process.cpu.system", { unit: "s" });
    rss.addCallback((result) => result.observe(sampleProcessResources().rssBytes));
    heap.addCallback((result) => result.observe(sampleProcessResources().heapUsedBytes));
    cpuUser.addCallback((result) => result.observe(sampleProcessResources().cpuUserMs / 1000));
    cpuSystem.addCallback((result) => result.observe(sampleProcessResources().cpuSystemMs / 1000));
  }

  /** Record exporter health without using dynamic error messages as labels. */
  recordExportFailure(
    signal: "traces" | "logs" | "metrics",
    reason: "request" | "partial" | "sink",
  ): void {
    this.exportFailures.add(1, { signal, reason });
  }

  recordDropped(count: number, reason: "capacity_or_age" | "permanent"): void {
    if (count > 0) this.exportDropped.add(count, { signal: "all", reason });
  }

  write(events: readonly TelemetryEvent[]): Promise<void> {
    for (const event of events) {
      const data = event.data;
      switch (event.type) {
        case "agent_run_completed":
        case "agent_run_failed": {
          const attributes = {
            "jazz.agent.id": label(event.agentId),
            status: event.type === "agent_run_failed" ? "error" : "ok",
          };
          this.runs.add(1, attributes);
          const duration = seconds(data["durationMs"]);
          if (duration !== undefined) this.runDuration.record(duration, attributes);
          break;
        }
        case "tool_invocation":
        case "tool_error": {
          const attributes = {
            "gen_ai.tool.name": toolLabel(data["toolName"]),
            status: event.type === "tool_error" ? "error" : "ok",
          };
          this.toolCalls.add(1, attributes);
          const duration = seconds(data["durationMs"]);
          if (duration !== undefined) this.toolDuration.record(duration, attributes);
          break;
        }
        case "llm_usage": {
          const attributes = {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": label(data["provider"]),
            "gen_ai.request.model": label(data["model"]),
          };
          this.llmCalls.add(1, attributes);
          const duration = seconds(data["durationMs"]);
          if (duration !== undefined) this.llmDuration.record(duration, attributes);
          const usage = data["usage"];
          if (usage && typeof usage === "object") {
            const tokens = usage as Record<string, unknown>;
            const input = tokens["promptTokens"];
            const output = tokens["completionTokens"];
            if (typeof input === "number" && Number.isFinite(input) && input >= 0)
              this.llmTokens.add(input, { ...attributes, "gen_ai.token.type": "input" });
            if (typeof output === "number" && Number.isFinite(output) && output >= 0)
              this.llmTokens.add(output, { ...attributes, "gen_ai.token.type": "output" });
          }
          break;
        }
        default:
          break;
      }
    }
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async close(): Promise<void> {
    await this.provider.shutdown();
  }
}
