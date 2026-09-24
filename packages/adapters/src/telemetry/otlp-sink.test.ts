import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import { serve } from "bun";
import { describe, expect, it } from "bun:test";
import type { ResolvedOtlpConfig } from "./otlp-config";
import { OtlpTelemetrySink } from "./otlp-sink";

const EVENT: TelemetryEvent = {
  id: "event-1",
  type: "llm_usage",
  timestamp: "2026-08-15T12:00:00.000Z",
  data: { provider: "anthropic", model: "claude-opus-5" },
};

function makeConfig(overrides: Partial<ResolvedOtlpConfig> = {}): ResolvedOtlpConfig {
  return {
    enabled: true,
    signals: ["logs"],
    tracesEndpoint: "http://collector.test/v1/traces",
    logsEndpoint: "http://collector.test/v1/logs",
    metricsEndpoint: "http://collector.test/v1/metrics",
    headers: {},
    signalHeaders: { traces: {}, logs: {}, metrics: {} },
    serviceName: "jazz",
    resourceAttributes: {},
    captureContent: false,
    timeoutMs: 1000,
    maxQueuedBytes: 1024 * 1024,
    maxQueueAgeMs: 60_000,
    metricExportIntervalMs: 30_000,
    ...overrides,
  };
}

/** Records calls and replies with a queue of responses. */
function stubFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) return new Response(null, { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe("OtlpTelemetrySink", () => {
  it("posts an OTLP payload to the configured logs endpoint", async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 200 })]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await sink.write([EVENT]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector.test/v1/logs");
    expect(calls[0]!.init.method).toBe("POST");

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[];
    };
    expect(body.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(1);
  });

  it("sends configured headers alongside the JSON content type", async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 200 })]);
    const sink = new OtlpTelemetrySink(
      makeConfig({
        headers: { authorization: "Basic abc" },
        signalHeaders: {
          traces: { authorization: "Basic abc" },
          logs: { authorization: "Basic abc" },
          metrics: { authorization: "Basic abc" },
        },
      }),
      "1.2.3",
      { fetch: impl, sleep: noSleep },
    );

    await sink.write([EVENT]);

    expect(calls[0]!.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Basic abc",
    });
  });

  it("does not call the endpoint for an empty batch", async () => {
    const { impl, calls } = stubFetch([]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await sink.write([]);

    expect(calls).toHaveLength(0);
  });

  it("retries a 503 and succeeds on a later attempt", async () => {
    const { impl, calls } = stubFetch([
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await sink.write([EVENT]);

    expect(calls).toHaveLength(2);
  });

  it("retries network failures", async () => {
    const { impl, calls } = stubFetch([
      new Error("ECONNREFUSED"),
      new Response(null, { status: 200 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await sink.write([EVENT]);

    expect(calls).toHaveLength(2);
  });

  it("does not retry a 500, which OTLP treats as non-retryable", async () => {
    const { impl, calls } = stubFetch([
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await expect(sink.write([EVENT])).rejects.toThrow("500");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401, which retrying cannot fix", async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 401 })]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await expect(sink.write([EVENT])).rejects.toThrow("401");
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 despite it being a 4xx", async () => {
    const { impl, calls } = stubFetch([
      new Response(null, { status: 429 }),
      new Response(null, { status: 200 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await sink.write([EVENT]);

    expect(calls).toHaveLength(2);
  });

  it("honors Retry-After when a collector throttles", async () => {
    const delays: number[] = [];
    const { impl } = stubFetch([
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      new Response(null, { status: 200 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", {
      fetch: impl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await sink.write([EVENT]);
    expect(delays).toEqual([2000]);
  });

  it("reports a partial success without retrying accepted records", async () => {
    const errors: string[] = [];
    const { impl, calls } = stubFetch([
      Response.json({
        partialSuccess: { rejectedLogRecords: "1", errorMessage: "invalid record" },
      }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", {
      fetch: impl,
      onExportError: (_, error) => errors.push(error.message),
    });

    await sink.write([EVENT]);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual(["OTLP logs partial success: 1 rejected"]);
  });

  it("replays a failed trace request from disk after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-otlp-outbox-"));
    try {
      const config = makeConfig({ signals: ["traces"] });
      const failed = stubFetch([
        new Response(null, { status: 503 }),
        new Response(null, { status: 503 }),
        new Response(null, { status: 503 }),
      ]);
      const first = new OtlpTelemetrySink(config, "1.2.3", {
        fetch: failed.impl,
        sleep: noSleep,
        outboxPath: directory,
      });
      await first.write([EVENT]);
      expect(failed.calls).toHaveLength(3);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(1);

      const recovered = stubFetch([new Response(null, { status: 200 })]);
      const second = new OtlpTelemetrySink(config, "1.2.3", {
        fetch: recovered.impl,
        sleep: noSleep,
        outboxPath: directory,
      });
      await second.flush();
      expect(recovered.calls).toHaveLength(1);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops a permanently rejected queued request without replaying it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-otlp-outbox-"));
    try {
      const dropped: string[] = [];
      const failed = stubFetch([new Response(null, { status: 400 })]);
      const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", {
        fetch: failed.impl,
        outboxPath: directory,
        onQueueDropped: (count, reason) => dropped.push(`${count}:${reason}`),
      });
      await sink.write([EVENT]);
      await sink.flush();
      expect(failed.calls).toHaveLength(1);
      expect(dropped).toEqual(["1:permanent"]);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("acknowledges logs independently while traces remain queued", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-otlp-outbox-"));
    try {
      const calls: string[] = [];
      let traceAvailable = false;
      const fetchImpl = (async (url: string | URL | Request) => {
        const signal = String(url).endsWith("/traces") ? "traces" : "logs";
        calls.push(signal);
        return new Response(null, { status: signal === "traces" && !traceAvailable ? 503 : 200 });
      }) as typeof globalThis.fetch;
      const sink = new OtlpTelemetrySink(makeConfig({ signals: ["traces", "logs"] }), "1.2.3", {
        fetch: fetchImpl,
        sleep: noSleep,
        outboxPath: directory,
      });
      await sink.write([EVENT]);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(1);
      traceAvailable = true;
      await sink.flush();
      expect(calls.filter((signal) => signal === "logs")).toHaveLength(1);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("posts spans to the traces endpoint when traces are selected", async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 200 })]);
    const sink = new OtlpTelemetrySink(makeConfig({ signals: ["traces"] }), "1.2.3", {
      fetch: impl,
      sleep: noSleep,
    });

    await sink.write([EVENT]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector.test/v1/traces");

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe("generate-response");
  });

  it("posts both signals when both are selected", async () => {
    const { impl, calls } = stubFetch([
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig({ signals: ["traces", "logs"] }), "1.2.3", {
      fetch: impl,
      sleep: noSleep,
    });

    await sink.write([EVENT]);

    expect(calls.map((call) => call.url).sort()).toEqual([
      "http://collector.test/v1/logs",
      "http://collector.test/v1/traces",
    ]);
  });

  it("skips the traces request when no event maps to a span", async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 200 })]);
    const sink = new OtlpTelemetrySink(makeConfig({ signals: ["traces"] }), "1.2.3", {
      fetch: impl,
      sleep: noSleep,
    });

    await sink.write([{ ...EVENT, type: "agent_run_started" }]);

    expect(calls).toHaveLength(0);
  });

  it("delivers to a real HTTP endpoint end to end", async () => {
    const received: unknown[] = [];
    const server = serve({
      port: 0,
      async fetch(request) {
        received.push(await request.json());
        return new Response(null, { status: 200 });
      },
    });

    try {
      const sink = new OtlpTelemetrySink(
        makeConfig({ logsEndpoint: `http://localhost:${server.port}/v1/logs` }),
        "1.2.3",
      );

      await sink.write([EVENT]);

      expect(received).toHaveLength(1);
      const payload = received[0] as {
        resourceLogs: {
          scopeLogs: { logRecords: { body: { stringValue: string } }[] }[];
        }[];
      };
      expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body.stringValue).toBe(
        "llm_usage",
      );
    } finally {
      await server.stop(true);
    }
  });
});
