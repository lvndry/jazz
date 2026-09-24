import type { TelemetryEvent, TelemetryEventType } from "@jazz/core/interfaces/telemetry";
import { describe, expect, it } from "bun:test";
import { buildLogsPayload, eventToAttributes, toLogRecord } from "./otlp-mapping";
import type { OtlpKeyValue } from "./otlp-mapping";
import { toSpan } from "./otlp-trace-mapping";

function makeEvent(
  type: TelemetryEventType,
  data: Record<string, unknown>,
  overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    id: "event-1",
    type,
    timestamp: "2026-08-15T12:00:00.000Z",
    data,
    ...overrides,
  };
}

function attributeMap(attributes: readonly OtlpKeyValue[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes) {
    result[attribute.key] = Object.values(attribute.value)[0];
  }
  return result;
}

describe("eventToAttributes", () => {
  it("maps provider, model and token usage onto GenAI semantic conventions", () => {
    const event = makeEvent(
      "llm_usage",
      {
        provider: "anthropic",
        model: "claude-opus-5",
        usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
        durationMs: 2300,
      },
      { agentId: "agent-1", conversationId: "conv-1" },
    );

    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(attributes["gen_ai.request.model"]).toBe("claude-opus-5");
    expect(attributes["gen_ai.response.model"]).toBe("claude-opus-5");
    expect(attributes["gen_ai.operation.name"]).toBe("chat");
    expect(attributes["gen_ai.usage.input_tokens"]).toBe("120");
    expect(attributes["gen_ai.usage.output_tokens"]).toBe("45");
  });

  it("encodes integers as strings per proto3 JSON", () => {
    const event = makeEvent("llm_usage", {
      usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
    });

    const attributes = eventToAttributes(event, false);
    const inputTokens = attributes.find((a) => a.key === "gen_ai.usage.input_tokens");

    expect(inputTokens?.value).toEqual({ intValue: "7" });
  });

  it("keeps non-semconv fields under the jazz namespace", () => {
    const event = makeEvent(
      "agent_run_completed",
      {
        runId: "run-1",
        agentName: "researcher",
        durationMs: 5000,
        finished: true,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cacheReadTokens: 99 },
      },
      { agentId: "agent-1", conversationId: "conv-1" },
    );

    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["jazz.event.type"]).toBe("agent_run_completed");
    expect(attributes["jazz.agent.id"]).toBe("agent-1");
    expect(attributes["jazz.conversation.id"]).toBe("conv-1");
    expect(attributes["jazz.runId"]).toBe("run-1");
    expect(attributes["jazz.finished"]).toBe(true);
    expect(attributes["jazz.usage.cacheReadTokens"]).toBe("99");
  });

  it("keeps classifier purpose and rollup under the jazz namespace", () => {
    const usageEvent = makeEvent("llm_usage", {
      provider: "openai",
      model: "gpt-4o-mini",
      purpose: "classifier",
      usage: { promptTokens: 180, completionTokens: 2, totalTokens: 182 },
    });
    const runEvent = makeEvent("agent_run_completed", {
      classifierUsage: {
        promptTokens: 180,
        completionTokens: 2,
        totalTokens: 182,
        requests: 1,
        durationMs: 40,
      },
      decisionUsage: {
        inputTokens: 12,
        outputTokens: 3,
        requests: 1,
        durationMs: 80,
        costUSD: 0.002,
        costUnknown: false,
      },
      process: { rssBytes: 50_000_000, heapUsedBytes: 20_000_000 },
    });

    const usageAttributes = attributeMap(eventToAttributes(usageEvent, false));
    const runAttributes = attributeMap(eventToAttributes(runEvent, false));

    expect(usageAttributes["jazz.purpose"]).toBe("classifier");
    expect(usageAttributes["gen_ai.usage.input_tokens"]).toBe("180");
    expect(runAttributes["jazz.classifierUsage.promptTokens"]).toBe("180");
    expect(runAttributes["jazz.classifierUsage.durationMs"]).toBe("40");
    expect(runAttributes["jazz.decisionUsage.inputTokens"]).toBe("12");
    expect(runAttributes["jazz.decisionUsage.costUSD"]).toBe(0.002);
    expect(runAttributes["jazz.process.rssBytes"]).toBe("50000000");
  });

  it("does not duplicate provider and model under the jazz namespace", () => {
    const event = makeEvent("llm_usage", { provider: "openai", model: "gpt-5" });
    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["jazz.provider"]).toBeUndefined();
    expect(attributes["jazz.model"]).toBeUndefined();
  });

  it("drops content-bearing keys when capture is off", () => {
    const event = makeEvent("tool_invocation", {
      toolName: "web_search",
      arguments: { query: "private thing" },
      result: "a long secret result",
    });

    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["jazz.toolName"]).toBe("web_search");
    expect(Object.keys(attributes).some((key) => key.startsWith("jazz.arguments"))).toBe(false);
    expect(attributes["jazz.result"]).toBeUndefined();
  });

  it("includes content-bearing keys when capture is on", () => {
    const event = makeEvent("tool_invocation", {
      toolName: "web_search",
      result: "a result",
    });

    const attributes = attributeMap(eventToAttributes(event, true));

    expect(attributes["langfuse.observation.output"]).toBe('"a result"');
    expect(attributes["jazz.result"]).toBeUndefined();
  });

  it("never exports raw error text, even when content capture is enabled", () => {
    const event = makeEvent("agent_run_failed", { error: "Authorization: Bearer secret-token" });

    const withoutContent = attributeMap(eventToAttributes(event, false));
    const withContent = attributeMap(eventToAttributes(event, true));

    expect(withoutContent["jazz.error"]).toBeUndefined();
    expect(withContent["jazz.error"]).toBeUndefined();
    expect(withoutContent["error.type"]).toBe("agent_run_failed");
    expect(JSON.stringify(withContent)).not.toContain("secret-token");
  });

  it("uses a bounded error category for backend filtering", () => {
    const attributes = attributeMap(
      eventToAttributes(makeEvent("llm_retry", { error: "rate_limit", attempt: 2 }), false),
    );

    expect(attributes["error.type"]).toBe("rate_limit");
  });

  it("does not export arbitrary custom or nested event data", () => {
    const attributes = attributeMap(
      eventToAttributes(
        makeEvent("custom", {
          secret: "private-token",
          metadata: { credential: "private-token" },
        }),
        false,
      ),
    );
    expect(JSON.stringify(attributes)).not.toContain("private-token");
  });

  it("keeps model-provided call identifiers out of exported attributes", () => {
    const attributes = attributeMap(
      eventToAttributes(
        makeEvent("tool_invocation", {
          runId: "run-1",
          toolName: "web_search",
          toolCallId: "secret-token",
        }),
        false,
      ),
    );
    expect(JSON.stringify(attributes)).not.toContain("secret-token");
  });

  it("maps conversation and inherited parent session to Langfuse", () => {
    const event = makeEvent(
      "llm_usage",
      {
        runId: "child-run",
        telemetryParent: { topRunId: "root", parentRunId: "parent", sessionId: "parent-session" },
      },
      { conversationId: "child-conversation" },
    );
    const attributes = attributeMap(eventToAttributes(event, false));
    expect(attributes["langfuse.session.id"]).toBe("parent-session");
    expect(attributes["jazz.conversation.id"]).toBe("child-conversation");
  });

  it("exports inclusive totals and cache/reasoning subsets on one generation", () => {
    const attributes = attributeMap(
      eventToAttributes(
        makeEvent("llm_usage", {
          provider: "anthropic",
          model: "claude-sonnet",
          usage: {
            promptTokens: 120,
            completionTokens: 45,
            totalTokens: 165,
            cacheReadTokens: 60,
            cacheWriteTokens: 10,
            reasoningTokens: 20,
          },
        }),
        false,
      ),
    );
    expect(attributes["gen_ai.usage.input_tokens"]).toBe("120");
    expect(attributes["gen_ai.usage.output_tokens"]).toBe("45");
    expect(attributes["gen_ai.usage.cache_read.input_tokens"]).toBe("60");
    expect(attributes["gen_ai.usage.cache_write.input_tokens"]).toBe("10");
    expect(attributes["gen_ai.usage.reasoning.output_tokens"]).toBe("20");
  });

  it("omits invalid token counts from GenAI attributes", () => {
    const attributes = attributeMap(
      eventToAttributes(
        makeEvent("llm_usage", {
          usage: { promptTokens: Number.NaN, completionTokens: -2, cacheReadTokens: 1.5 },
        }),
        false,
      ),
    );
    expect(attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(attributes["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
  });

  it("ignores command arguments even in legacy events", () => {
    const event = makeEvent("command_executed", {
      command: "run",
      args: ["--prompt", "something private"],
    });

    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["jazz.args.count"]).toBeUndefined();
    expect(JSON.stringify(attributes)).not.toContain("something private");
  });
});

describe("toLogRecord", () => {
  it("converts the timestamp to unix nanoseconds", () => {
    const record = toLogRecord(makeEvent("llm_usage", {}), false);

    expect(record.timeUnixNano).toBe(String(Date.parse("2026-08-15T12:00:00.000Z") * 1_000_000));
  });

  it("raises severity for failures and retries", () => {
    expect(toLogRecord(makeEvent("tool_error", {}), false).severityText).toBe("ERROR");
    expect(toLogRecord(makeEvent("agent_run_failed", {}), false).severityText).toBe("ERROR");
    expect(toLogRecord(makeEvent("llm_retry", {}), false).severityText).toBe("WARN");
    expect(toLogRecord(makeEvent("llm_usage", {}), false).severityText).toBe("DEBUG");
  });

  it("uses the event type as the record body", () => {
    expect(toLogRecord(makeEvent("agent_run_started", {}), false).body).toEqual({
      stringValue: "agent_run_started",
    });
  });

  it("correlates a run-scoped tool log with its exported span", () => {
    const event = makeEvent("tool_invocation", {
      runId: "run-1",
      toolCallId: "dispatch-1",
      toolName: "spawn_subagent",
    });
    const record = toLogRecord(event, false);
    const span = toSpan(event, false);

    expect(record.traceId).toBe(span.traceId);
    expect(record.spanId).toBe(span.spanId);
  });

  it("keeps child logs in the parent trace and links run start to its root span", () => {
    const parent = {
      topRunId: "run-root",
      parentRunId: "run-parent",
      parentToolCallId: "dispatch-1",
      sessionId: "conversation-root",
    };
    const started = makeEvent("agent_run_started", {
      runId: "run-child",
      telemetryParent: parent,
    });
    const completed = makeEvent("agent_run_completed", {
      runId: "run-child",
      telemetryParent: parent,
    });
    const startLog = toLogRecord(started, false);
    const childSpan = toSpan(completed, false);

    expect(startLog.traceId).toBe(childSpan.traceId);
    expect(startLog.spanId).toBe(childSpan.spanId);
  });

  it("does not invent a trace context for a standalone CLI command", () => {
    const record = toLogRecord(makeEvent("command_executed", { command: "list" }), false);

    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  it("correlates a standalone LLM event log with its root span", () => {
    const event = makeEvent("llm_usage", { model: "gpt-4" }, { conversationId: "conv-9" });
    const record = toLogRecord(event, false);
    const span = toSpan(event, false);

    expect(span.parentSpanId).toBeUndefined();
    expect(record.traceId).toBe(span.traceId);
    expect(record.spanId).toBe(span.spanId);
  });
});

describe("buildLogsPayload", () => {
  it("wraps records in the OTLP resource and scope envelope", () => {
    const payload = buildLogsPayload([makeEvent("llm_usage", {})], {
      serviceName: "jazz-prod",
      serviceVersion: "1.2.3",
      captureContent: false,
    });

    const resourceAttributes = attributeMap(payload.resourceLogs[0]!.resource.attributes);
    expect(resourceAttributes["service.name"]).toBe("jazz-prod");
    expect(resourceAttributes["service.version"]).toBe("1.2.3");
    expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(1);
  });

  it("is JSON-serialisable", () => {
    const payload = buildLogsPayload([makeEvent("llm_usage", { model: "gpt-5" })], {
      serviceName: "jazz",
      serviceVersion: "1.0.0",
      captureContent: false,
    });

    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it("attaches operator resource attributes such as deployment.environment", () => {
    const payload = buildLogsPayload([makeEvent("llm_usage", {})], {
      serviceName: "ksyl-reviewer",
      serviceVersion: "1.2.3",
      resourceAttributes: {
        "deployment.environment": "production",
        "service.namespace": "ksyl",
        "service.instance.id": "instance-1",
      },
      captureContent: false,
    });

    const resourceAttributes = attributeMap(payload.resourceLogs[0]!.resource.attributes);
    expect(resourceAttributes["deployment.environment"]).toBe("production");
    expect(resourceAttributes["service.namespace"]).toBe("ksyl");
    expect(resourceAttributes["service.instance.id"]).toBe("instance-1");
  });

  it("never lets a resource attribute shadow a reserved key", () => {
    const payload = buildLogsPayload([makeEvent("llm_usage", {})], {
      serviceName: "resolved",
      serviceVersion: "1.2.3",
      resourceAttributes: { "service.name": "sneaky" },
      captureContent: false,
    });

    const serviceNames = payload.resourceLogs[0]!.resource.attributes.filter(
      (attribute) => attribute.key === "service.name",
    );
    expect(serviceNames).toHaveLength(1);
    expect(serviceNames[0]!.value).toEqual({ stringValue: "resolved" });
  });
});
