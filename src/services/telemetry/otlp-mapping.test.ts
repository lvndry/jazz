import { describe, expect, it } from "bun:test";
import type { TelemetryEvent, TelemetryEventType } from "@/core/interfaces/telemetry";
import { buildLogsPayload, eventToAttributes, toLogRecord } from "./otlp-mapping";
import type { OtlpKeyValue } from "./otlp-mapping";

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

    expect(attributes["gen_ai.system"]).toBe("anthropic");
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

    expect(attributes["jazz.result"]).toBe("a result");
  });

  it("truncates long strings hard when capture is off", () => {
    const event = makeEvent("agent_run_failed", { error: "x".repeat(5000) });

    const withoutContent = attributeMap(eventToAttributes(event, false));
    const withContent = attributeMap(eventToAttributes(event, true));

    expect(String(withoutContent["jazz.error"]).length).toBe(256);
    expect(String(withContent["jazz.error"]).length).toBe(5000);
  });

  it("summarises arrays by length rather than emitting their contents", () => {
    const event = makeEvent("command_executed", {
      command: "run",
      args: ["--prompt", "something private"],
    });

    const attributes = attributeMap(eventToAttributes(event, false));

    expect(attributes["jazz.args.count"]).toBe("2");
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
    expect(toLogRecord(makeEvent("llm_usage", {}), false).severityText).toBe("INFO");
  });

  it("uses the event type as the record body", () => {
    expect(toLogRecord(makeEvent("agent_run_started", {}), false).body).toEqual({
      stringValue: "agent_run_started",
    });
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
});
