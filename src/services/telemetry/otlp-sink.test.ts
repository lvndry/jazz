import { serve } from "bun";
import { describe, expect, it } from "bun:test";
import type { TelemetryEvent } from "@/core/interfaces/telemetry";
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
    headers: {},
    serviceName: "jazz",
    captureContent: false,
    timeoutMs: 1000,
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
      makeConfig({ headers: { authorization: "Basic abc" } }),
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

  it("gives up after the attempt ceiling and rejects", async () => {
    const { impl, calls } = stubFetch([
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
    ]);
    const sink = new OtlpTelemetrySink(makeConfig(), "1.2.3", { fetch: impl, sleep: noSleep });

    await expect(sink.write([EVENT])).rejects.toThrow("500");
    expect(calls).toHaveLength(3);
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
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe("chat claude-opus-5");
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
