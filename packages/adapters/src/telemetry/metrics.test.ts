import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { serve } from "bun";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { OtlpMetricsSink } from "./metrics";
import { resolveOtlpConfig } from "./otlp-config";
import { TelemetryServiceImpl } from "./telemetry-service";

const EVENT: TelemetryEvent = {
  id: "llm-1",
  type: "llm_usage",
  timestamp: "2026-09-24T12:00:00.000Z",
  data: {
    provider: "openai",
    model: "gpt-5",
    durationMs: 1200,
    usage: { promptTokens: 42, completionTokens: 7, totalTokens: 49 },
  },
};

describe("OtlpMetricsSink", () => {
  it("exports a zero run count before a short CLI run and its result on shutdown", async () => {
    const config = resolveOtlpConfig(
      { metricsEndpoint: "http://localhost:4318/v1/metrics", signals: ["metrics"] },
      {},
    );
    expect(config).toBeDefined();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const sink = new OtlpMetricsSink(config!, "1.2.3", () => {}, exporter);
    const service = new TelemetryServiceImpl({
      enabled: true,
      bufferSize: 100,
      flushIntervalMs: 0,
      sinks: [sink],
      metricsSink: sink,
    });

    await Effect.runPromise(
      service.recordAgentRunStarted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "Test agent",
        conversationId: "conversation-1",
      }),
    );
    await Effect.runPromise(
      service.recordAgentRunFailed({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "Test agent",
        conversationId: "conversation-1",
        error: "provider",
        durationMs: 1200,
      }),
    );
    await Effect.runPromise(service.shutdown());

    const snapshots = exporter.getMetrics();
    expect(snapshots).toHaveLength(2);
    const runCount = (index: number, status: "ok" | "error") => {
      const metric = snapshots[index]?.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .find((item) => item.descriptor.name === "jazz.agent.runs");
      expect(metric?.dataPointType).toBe(DataPointType.SUM);
      if (metric?.dataPointType !== DataPointType.SUM) return undefined;
      return metric.dataPoints.find((point) => point.attributes["status"] === status)?.value;
    };
    expect(runCount(0, "error")).toBe(0);
    expect(runCount(1, "error")).toBe(1);
    expect(runCount(1, "ok")).toBe(0);
  });

  it("exports real OTLP/protobuf metrics to the metrics endpoint", async () => {
    const received: { path: string; contentType: string | null; size: number }[] = [];
    const server = serve({
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type"),
          size: (await request.arrayBuffer()).byteLength,
        });
        return Response.json({});
      },
    });
    const config = resolveOtlpConfig(
      {
        endpoint: `http://localhost:${server.port}`,
        signals: ["metrics"],
        metricExportIntervalMs: 500,
        timeoutMs: 1000,
      },
      {},
    );
    expect(config).toBeDefined();
    const sink = new OtlpMetricsSink(config!, "1.2.3");
    try {
      await sink.write([EVENT]);
      await sink.flush();
      expect(received).toHaveLength(1);
      expect(received[0]!.path).toBe("/v1/metrics");
      expect(received[0]!.contentType).toBe("application/x-protobuf");
      expect(received[0]!.size).toBeGreaterThan(50);
    } finally {
      await sink.close();
      await server.stop(true);
    }
  });

  it("reports a failed periodic export and keeps the failure counter for recovery", async () => {
    let requests = 0;
    const payloads: Uint8Array[] = [];
    const server = serve({
      port: 0,
      async fetch(request) {
        requests += 1;
        payloads.push(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: requests === 1 ? 400 : 200 });
      },
    });
    const config = resolveOtlpConfig(
      {
        endpoint: `http://localhost:${server.port}`,
        signals: ["metrics"],
        metricExportIntervalMs: 100,
        timeoutMs: 100,
      },
      {},
    );
    expect(config).toBeDefined();
    let reportFailure: (() => void) | undefined;
    const failed = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const sink = new OtlpMetricsSink(config!, "1.2.3", () => reportFailure?.());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await sink.write([EVENT]);
      await Promise.race([
        failed,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("periodic export did not report failure")),
            1500,
          );
        }),
      ]);
      expect(requests).toBeGreaterThanOrEqual(1);
      await sink.flush();
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(new TextDecoder().decode(payloads[1])).toContain("jazz.telemetry.export.failures");
    } finally {
      if (timeout) clearTimeout(timeout);
      await sink.close();
      await server.stop(true);
    }
  });
});
