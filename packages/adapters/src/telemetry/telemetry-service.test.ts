import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { TelemetryServiceTag, type TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import type { AppConfig } from "@jazz/core/types/config";
import { serve } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileTelemetrySink } from "./file-sink";
import type { TelemetrySink } from "./sink";
import { createTelemetryServiceLayer, TelemetryServiceImpl } from "./telemetry-service";

class RecordingSink implements TelemetrySink {
  readonly written: TelemetryEvent[] = [];
  constructor(readonly name: string) {}
  async write(events: readonly TelemetryEvent[]): Promise<void> {
    this.written.push(...events);
  }
}

class FailingSink implements TelemetrySink {
  attempts = 0;
  constructor(readonly name: string) {}
  async write(): Promise<void> {
    this.attempts += 1;
    throw new Error("sink is down");
  }
}

function makeService(sinks: TelemetrySink[], overrides: { bufferSize?: number } = {}) {
  return new TelemetryServiceImpl({
    enabled: true,
    bufferSize: overrides.bufferSize ?? 100,
    flushIntervalMs: 0,
    sinks,
  });
}

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function factoryLayer(config: AppConfig, logEntries: string[]) {
  const configService = { appConfig: Effect.succeed(config) } as AgentConfigService;
  const logger = {
    debug: (message: string, meta?: Record<string, unknown>) =>
      Effect.sync(() => {
        logEntries.push(JSON.stringify({ message, meta }));
      }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      Effect.sync(() => {
        logEntries.push(JSON.stringify({ message, meta }));
      }),
    error: (message: string, meta?: Record<string, unknown>) =>
      Effect.sync(() => {
        logEntries.push(JSON.stringify({ message, meta }));
      }),
  } as LoggerService;
  return createTelemetryServiceLayer().pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(AgentConfigServiceTag, configService),
        Layer.succeed(LoggerServiceTag, logger),
      ),
    ),
  );
}

function appConfig(telemetry: AppConfig["telemetry"]): AppConfig {
  return {
    storage: { type: "file", path: "/tmp" },
    logging: { level: "info", format: "plain" },
    ...(telemetry ? { telemetry } : {}),
  };
}

describe("TelemetryServiceImpl sink fan-out", () => {
  it("writes every event to every sink", async () => {
    const first = new RecordingSink("first");
    const second = new RecordingSink("second");
    const service = makeService([first, second]);

    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );
    await Effect.runPromise(service.flush());

    expect(first.written).toHaveLength(1);
    expect(second.written).toHaveLength(1);
    expect(first.written[0]!.type).toBe("llm_usage");
  });

  it("retains typed trace ancestry and session on retry events", async () => {
    const sink = new RecordingSink("recording");
    const service = makeService([sink]);
    const telemetryParent = { topRunId: "root", parentRunId: "parent", sessionId: "session" };
    await Effect.runPromise(
      service.recordLLMRetry({
        provider: "openai",
        model: "gpt-5",
        error: "network",
        attempt: 2,
        runId: "child",
        conversationId: "session",
        telemetryParent,
      }),
    );
    await Effect.runPromise(service.flush());
    expect(sink.written[0]?.conversationId).toBe("session");
    expect(sink.written[0]?.data["telemetryParent"]).toEqual(telemetryParent);
  });

  it("keeps writing to healthy sinks when one fails", async () => {
    const healthy = new RecordingSink("healthy");
    const broken = new FailingSink("broken");
    const service = makeService([broken, healthy]);

    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );
    await Effect.runPromise(service.flush());

    expect(broken.attempts).toBe(1);
    expect(healthy.written).toHaveLength(1);
  });

  it("does not surface a sink failure to the caller", async () => {
    const service = makeService([new FailingSink("broken")]);

    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );

    // flush() resolving rather than rejecting is the contract callers rely on.
    await Effect.runPromise(service.flush());
  });

  it("reports failing sinks by name", async () => {
    const errors: string[] = [];
    const service = new TelemetryServiceImpl({
      enabled: true,
      bufferSize: 100,
      flushIntervalMs: 0,
      sinks: [new FailingSink("broken")],
      onSinkError: (sinkName) => errors.push(sinkName),
    });

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );
    await Effect.runPromise(service.flush());

    expect(errors).toEqual(["broken"]);
  });

  it("retries a failed sink's batch on the next flush", async () => {
    const broken = new FailingSink("broken");
    const service = makeService([broken]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );
    await Effect.runPromise(service.flush());
    await Effect.runPromise(service.flush());

    // The same event is retried on the next flush rather than dropped.
    expect(broken.attempts).toBe(2);
  });

  it("retains a failed sink's batch without duplicating the healthy sink", async () => {
    const healthy = new RecordingSink("healthy");
    const broken = new FailingSink("broken");
    const service = makeService([broken, healthy]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );
    await Effect.runPromise(service.flush());
    await Effect.runPromise(service.flush());

    // Re-enqueueing would duplicate the row in the healthy sink.
    expect(healthy.written).toHaveLength(1);
    expect(broken.attempts).toBe(2);
  });

  it("drops the oldest events once the buffer ceiling is hit", async () => {
    const dropped: number[] = [];
    const service = new TelemetryServiceImpl({
      enabled: true,
      bufferSize: 2,
      flushIntervalMs: 0,
      sinks: [new FailingSink("broken")],
      onEventsDropped: (count) => dropped.push(count),
    });

    // bufferSize 2 × the 10× ceiling = 20 retained; 30 events overflows it.
    for (let index = 0; index < 30; index++) {
      await Effect.runPromise(
        service.recordToolInvocation({ toolName: "web_search", success: true }),
      );
    }
    await Effect.runPromise(service.flush());

    expect(dropped.reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
  });

  it("records nothing when disabled", async () => {
    const sink = new RecordingSink("only");
    const service = new TelemetryServiceImpl({
      enabled: false,
      bufferSize: 100,
      flushIntervalMs: 0,
      sinks: [sink],
    });

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );
    await Effect.runPromise(service.flush());

    expect(sink.written).toHaveLength(0);
  });

  it("flushes pending events and closes sinks on shutdown", async () => {
    let closed = 0;
    const written: TelemetryEvent[] = [];
    const sink: TelemetrySink = {
      name: "closeable",
      write: async (events) => {
        written.push(...events);
      },
      close: async () => {
        closed += 1;
      },
    };
    const service = makeService([sink]);
    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );
    await Effect.runPromise(service.shutdown());
    expect(written).toHaveLength(1);
    expect(closed).toBe(1);
  });
});

describe("telemetry layer export wiring", () => {
  it("reports a startup error when an invalid endpoint disables OTLP export", async () => {
    const logEntries: string[] = [];
    const layer = factoryLayer(
      appConfig({
        flushIntervalMs: 0,
        otlp: { endpoint: "https://user:SECRET@collector.invalid" },
      }),
      logEntries,
    );
    const service = await Effect.runPromise(Effect.provide(TelemetryServiceTag, layer));
    await Effect.runPromise(service.shutdown());

    const logged = logEntries.join("\n");
    expect(logged).toContain("OTLP export disabled by invalid configuration");
    expect(logged).toContain("telemetry.otlp.endpoint");
    expect(logged).not.toContain("SECRET");
  });

  it("does not start OTLP metrics when telemetry is globally disabled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-disabled-"));
    let requests = 0;
    const server = serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response(null, { status: 200 });
      },
    });
    try {
      const layer = factoryLayer(
        appConfig({
          enabled: false,
          storagePath: directory,
          otlp: {
            endpoint: `http://localhost:${server.port}`,
            signals: ["metrics"],
            metricExportIntervalMs: 100,
            timeoutMs: 100,
          },
        }),
        [],
      );
      const service = await Effect.runPromise(Effect.provide(TelemetryServiceTag, layer));
      await new Promise((resolve) => setTimeout(resolve, 220));
      await Effect.runPromise(service.shutdown());
      expect(requests).toBe(0);
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares the process resource id and keeps URL, path, and headers out of logs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-secret-path-"));
    const logEntries: string[] = [];
    const received: { path: string; body: string }[] = [];
    const server = serve({
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          body: await request.text(),
        });
        return new Response(null, { status: 200 });
      },
    });
    try {
      const layer = factoryLayer(
        appConfig({
          storagePath: directory,
          flushIntervalMs: 0,
          otlp: {
            endpoint: `http://localhost:${server.port}/otlp?apikey=SECRET_QUERY`,
            headers: { authorization: "SECRET_HEADER" },
            signals: ["traces", "metrics"],
          },
        }),
        logEntries,
      );
      const service = await Effect.runPromise(Effect.provide(TelemetryServiceTag, layer));
      await Effect.runPromise(
        service.recordLLMUsage({ provider: "openai", model: "gpt-5", usage: USAGE }),
      );
      await Effect.runPromise(service.flush());
      await Effect.runPromise(service.shutdown());
      const trace = received.find((item) => item.path.endsWith("/v1/traces"));
      const metrics = received.find((item) => item.path.endsWith("/v1/metrics"));
      expect(trace).toBeDefined();
      expect(metrics).toBeDefined();
      const traceBody = JSON.parse(trace!.body) as {
        resourceSpans: {
          resource: { attributes: { key: string; value: { stringValue: string } }[] };
        }[];
      };
      const instance = traceBody.resourceSpans[0]!.resource.attributes.find(
        (item) => item.key === "service.instance.id",
      )?.value.stringValue;
      expect(instance).toBeTruthy();
      expect(metrics!.body).toContain(instance!);
      const logged = logEntries.join("\n");
      expect(logged).not.toContain("SECRET_QUERY");
      expect(logged).not.toContain("SECRET_HEADER");
      expect(logged).not.toContain(directory);
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("TelemetryServiceImpl querying", () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await mkdtemp(path.join(tmpdir(), "jazz-telemetry-test-"));
  });

  afterEach(async () => {
    await rm(storagePath, { recursive: true, force: true });
  });

  it("reads back events written to the file sink", async () => {
    const service = makeService([new FileTelemetrySink(storagePath, 90)]);

    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );
    await Effect.runPromise(service.flush());

    const events = await Effect.runPromise(service.getEvents());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("llm_usage");
  });

  it("includes buffered events that have not been flushed yet", async () => {
    const service = makeService([new FileTelemetrySink(storagePath, 90)]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );

    const events = await Effect.runPromise(service.getEvents());
    expect(events).toHaveLength(1);
  });

  it("returns only buffered events when no sink can be read back", async () => {
    const service = makeService([new RecordingSink("write-only")]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true }),
    );

    const events = await Effect.runPromise(service.getEvents());
    expect(events).toHaveLength(1);
  });

  it("filters by type and agent", async () => {
    const service = makeService([new FileTelemetrySink(storagePath, 90)]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true, agentId: "agent-1" }),
    );
    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "shell", success: false, agentId: "agent-2" }),
    );
    await Effect.runPromise(service.flush());

    const toolErrors = await Effect.runPromise(service.getEvents({ types: ["tool_error"] }));
    expect(toolErrors).toHaveLength(1);

    const agentOne = await Effect.runPromise(service.getEvents({ agentId: "agent-1" }));
    expect(agentOne).toHaveLength(1);
    expect(agentOne[0]!.type).toBe("tool_invocation");
  });
});

describe("TelemetryServiceImpl usage aggregation", () => {
  it("counts tool calls once when both run and invocation events are present", async () => {
    const service = makeService([new RecordingSink("memory")]);

    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "web_search", success: true, agentId: "agent-1" }),
    );
    await Effect.runPromise(
      service.recordToolInvocation({ toolName: "shell", success: false, agentId: "agent-1" }),
    );
    await Effect.runPromise(
      service.recordAgentRunCompleted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "researcher",
        conversationId: "conv-1",
        durationMs: 5000,
        iterationsUsed: 2,
        finished: true,
        usage: USAGE,
        toolCalls: 2,
        toolErrors: 1,
      }),
    );

    const summary = await Effect.runPromise(service.getUsageSummary());

    expect(summary.totalToolCalls).toBe(2);
    expect(summary.totalToolErrors).toBe(1);
    expect(summary.totalAgentRuns).toBe(1);
  });

  it("counts wall-clock duration once, from the run rather than each request", async () => {
    const service = makeService([new RecordingSink("memory")]);

    await Effect.runPromise(
      service.recordLLMUsage({
        provider: "anthropic",
        model: "claude-opus-5",
        usage: USAGE,
        durationMs: 2000,
      }),
    );
    await Effect.runPromise(
      service.recordAgentRunCompleted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "researcher",
        conversationId: "conv-1",
        durationMs: 5000,
        iterationsUsed: 1,
        finished: true,
        usage: USAGE,
        toolCalls: 0,
        toolErrors: 0,
      }),
    );

    const summary = await Effect.runPromise(service.getUsageSummary());

    expect(summary.totalDurationMs).toBe(5000);
  });

  it("breaks token usage down per model", async () => {
    const service = makeService([new RecordingSink("memory")]);

    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );
    await Effect.runPromise(
      service.recordLLMUsage({ provider: "anthropic", model: "claude-opus-5", usage: USAGE }),
    );

    const summary = await Effect.runPromise(service.getUsageSummary());

    expect(summary.totalRequests).toBe(2);
    expect(summary.totalTokens).toBe(30);
    expect(summary.byModel["anthropic/claude-opus-5"]?.requests).toBe(2);
  });

  it("splits classifier tokens out of llm_usage by purpose", async () => {
    const service = makeService([new RecordingSink("memory")]);

    await Effect.runPromise(
      service.recordLLMUsage({
        provider: "openai",
        model: "gpt-4o",
        usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
      }),
    );
    await Effect.runPromise(
      service.recordLLMUsage({
        provider: "openai",
        model: "gpt-4o-mini",
        usage: { promptTokens: 180, completionTokens: 2, totalTokens: 182 },
        purpose: "classifier",
      }),
    );

    const summary = await Effect.runPromise(service.getUsageSummary());

    expect(summary.totalRequests).toBe(2);
    expect(summary.promptTokens).toBe(1180);
    expect(summary.classifierRequests).toBe(1);
    expect(summary.classifierPromptTokens).toBe(180);
    expect(summary.classifierCompletionTokens).toBe(2);
  });

  it("attaches a Jazz process snapshot to run start and end", async () => {
    const sink = new RecordingSink("memory");
    const service = makeService([sink]);

    await Effect.runPromise(
      service.recordAgentRunStarted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "researcher",
        conversationId: "conv-1",
      }),
    );
    await Effect.runPromise(
      service.recordAgentRunCompleted({
        runId: "run-1",
        agentId: "agent-1",
        agentName: "researcher",
        conversationId: "conv-1",
        durationMs: 100,
        iterationsUsed: 1,
        finished: true,
        usage: USAGE,
        toolCalls: 0,
        toolErrors: 0,
      }),
    );
    await Effect.runPromise(service.flush());

    const started = sink.written.find((event) => event.type === "agent_run_started");
    const completed = sink.written.find((event) => event.type === "agent_run_completed");
    const startedProcess = started?.data["process"] as { rssBytes?: number } | undefined;
    const completedProcess = completed?.data["process"] as { rssBytes?: number } | undefined;

    expect(startedProcess?.rssBytes).toBeGreaterThan(0);
    expect(completedProcess?.rssBytes).toBeGreaterThan(0);
  });
});
