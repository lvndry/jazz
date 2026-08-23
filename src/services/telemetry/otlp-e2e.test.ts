import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { FileTelemetrySink } from "./file-sink";
import { resolveOtlpConfig } from "./otlp-config";
import { OtlpTelemetrySink } from "./otlp-sink";
import { TelemetryServiceImpl } from "./telemetry-service";

interface CapturedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
}

/**
 * Drives a whole run's worth of events through the service and a real HTTP
 * endpoint, asserting the collector receives one connected trace.
 */
describe("OTLP export end to end", () => {
  it("delivers a run as a single connected trace", async () => {
    const receivedSpans: CapturedSpan[] = [];
    const receivedPaths: string[] = [];

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        receivedPaths.push(new URL(request.url).pathname);
        const payload = (await request.json()) as {
          resourceSpans: { scopeSpans: { spans: CapturedSpan[] }[] }[];
        };
        for (const resourceSpan of payload.resourceSpans) {
          for (const scopeSpan of resourceSpan.scopeSpans) {
            receivedSpans.push(...scopeSpan.spans);
          }
        }
        return new Response(null, { status: 200 });
      },
    });

    try {
      const otlpConfig = resolveOtlpConfig(undefined, {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${server.port}`,
      });
      expect(otlpConfig).toBeDefined();

      const service = new TelemetryServiceImpl({
        enabled: true,
        bufferSize: 100,
        flushIntervalMs: 0,
        sinks: [new OtlpTelemetrySink(otlpConfig!, "1.2.3")],
      });

      const runId = "run-e2e";
      const shared = { agentId: "agent-1", logScope: "conv-1", runId };

      await Effect.runPromise(
        service.recordAgentRunStarted({
          runId,
          agentId: "agent-1",
          agentName: "researcher",
          conversationId: "conv-1",
        }),
      );
      await Effect.runPromise(
        service.recordLLMUsage({
          provider: "anthropic",
          model: "claude-opus-5",
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          durationMs: 2000,
          ...shared,
        }),
      );
      await Effect.runPromise(
        service.recordToolInvocation({
          toolName: "web_search",
          success: true,
          durationMs: 500,
          ...shared,
        }),
      );
      await Effect.runPromise(
        service.recordAgentRunCompleted({
          runId,
          agentId: "agent-1",
          agentName: "researcher",
          conversationId: "conv-1",
          provider: "anthropic",
          model: "claude-opus-5",
          durationMs: 5000,
          iterationsUsed: 2,
          finished: true,
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          toolCalls: 1,
          toolErrors: 0,
        }),
      );

      await Effect.runPromise(service.flush());

      expect(receivedPaths).toEqual(["/v1/traces"]);

      // agent_run_started contributes no span; the other three do.
      expect(receivedSpans).toHaveLength(3);

      const traceIds = new Set(receivedSpans.map((span) => span.traceId));
      expect(traceIds.size).toBe(1);

      const root = receivedSpans.find((span) => span.parentSpanId === undefined);
      expect(root?.name).toBe("agent researcher");

      const children = receivedSpans.filter((span) => span.parentSpanId !== undefined);
      expect(children.map((span) => span.name).sort()).toEqual([
        "chat claude-opus-5",
        "tool web_search",
      ]);
      expect(children.every((span) => span.parentSpanId === root?.spanId)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  it("keeps writing locally when the collector is unreachable", async () => {
    const storagePath = await mkdtemp(path.join(tmpdir(), "jazz-otlp-e2e-"));

    const otlpConfig = resolveOtlpConfig({ endpoint: "http://127.0.0.1:1" }, {});
    const fileSink = new FileTelemetrySink(storagePath, 90);

    const service = new TelemetryServiceImpl({
      enabled: true,
      bufferSize: 100,
      flushIntervalMs: 0,
      sinks: [new OtlpTelemetrySink(otlpConfig!, "1.2.3"), fileSink],
    });

    await Effect.runPromise(
      service.recordAgentRunCompleted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "researcher",
        conversationId: "conv-1",
        durationMs: 100,
        iterationsUsed: 1,
        finished: true,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: 0,
        toolErrors: 0,
      }),
    );

    // Resolves despite the dead collector — export never fails a run.
    await Effect.runPromise(service.flush());

    const stored = await fileSink.readAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.type).toBe("agent_run_completed");

    await rm(storagePath, { recursive: true, force: true });
  }, 20_000);
});
