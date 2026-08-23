import { describe, expect, it } from "bun:test";
import type { TelemetryEvent, TelemetryEventType } from "@/core/interfaces/telemetry";
import {
  buildTracesPayload,
  isSpanEvent,
  rootSpanIdForRun,
  toSpan,
  traceIdForRun,
} from "./otlp-trace-mapping";

function makeEvent(
  type: TelemetryEventType,
  data: Record<string, unknown>,
  overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    id: `event-${type}`,
    type,
    timestamp: "2026-08-15T12:00:30.000Z",
    data,
    ...overrides,
  };
}

describe("trace and span ids", () => {
  it("derives ids of the byte lengths OTLP requires", () => {
    expect(traceIdForRun("run-1")).toHaveLength(32);
    expect(rootSpanIdForRun("run-1")).toHaveLength(16);
  });

  it("is deterministic, so spans from separate batches join the same trace", () => {
    expect(traceIdForRun("run-1")).toBe(traceIdForRun("run-1"));
    expect(traceIdForRun("run-1")).not.toBe(traceIdForRun("run-2"));
  });
});

describe("toSpan", () => {
  it("makes the run's terminal event the root span", () => {
    const span = toSpan(
      makeEvent("agent_run_completed", {
        runId: "run-1",
        agentName: "researcher",
        durationMs: 30_000,
      }),
      false,
    );

    expect(span.spanId).toBe(rootSpanIdForRun("run-1"));
    expect(span.parentSpanId).toBeUndefined();
    expect(span.name).toBe("agent researcher");
  });

  it("parents LLM and tool spans to the run's root span", () => {
    const llmSpan = toSpan(
      makeEvent("llm_usage", { runId: "run-1", model: "claude-opus-5", durationMs: 2000 }),
      false,
    );
    const toolSpan = toSpan(
      makeEvent("tool_invocation", { runId: "run-1", toolName: "web_search", durationMs: 500 }),
      false,
    );

    expect(llmSpan.traceId).toBe(traceIdForRun("run-1"));
    expect(toolSpan.traceId).toBe(traceIdForRun("run-1"));
    expect(llmSpan.parentSpanId).toBe(rootSpanIdForRun("run-1"));
    expect(toolSpan.parentSpanId).toBe(rootSpanIdForRun("run-1"));
    expect(llmSpan.spanId).not.toBe(toolSpan.spanId);
  });

  it("derives the span start by subtracting duration from the event time", () => {
    const span = toSpan(makeEvent("llm_usage", { runId: "run-1", durationMs: 2000 }), false);

    const endMs = Date.parse("2026-08-15T12:00:30.000Z");
    expect(span.endTimeUnixNano).toBe(String(endMs * 1_000_000));
    expect(span.startTimeUnixNano).toBe(String((endMs - 2000) * 1_000_000));
  });

  it("produces a zero-length span when no duration was recorded", () => {
    const span = toSpan(makeEvent("llm_retry", { runId: "run-1" }), false);

    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
  });

  it("marks failures with error status and message", () => {
    const runSpan = toSpan(
      makeEvent("agent_run_failed", { runId: "run-1", error: "provider unreachable" }),
      false,
    );
    const toolSpan = toSpan(
      makeEvent("tool_error", { runId: "run-1", toolName: "shell", error: "exit 1" }),
      false,
    );

    expect(runSpan.status).toEqual({ code: 2, message: "provider unreachable" });
    expect(toolSpan.status).toEqual({ code: 2, message: "exit 1" });
  });

  it("leaves successful spans with unset status", () => {
    const span = toSpan(makeEvent("tool_invocation", { runId: "run-1" }), false);
    expect(span.status.code).toBe(0);
  });

  it("names LLM spans after the model, per GenAI semconv", () => {
    expect(toSpan(makeEvent("llm_usage", { model: "gpt-5" }), false).name).toBe("chat gpt-5");
  });

  it("falls back to the conversation when an event carries no run id", () => {
    const span = toSpan(makeEvent("tool_invocation", {}, { conversationId: "conv-9" }), false);
    expect(span.traceId).toBe(traceIdForRun("conv-9"));
  });

  it("makes an event with neither run nor conversation its own root span", () => {
    const span = toSpan(makeEvent("custom", { note: "standalone" }), false);

    expect(span.traceId).toHaveLength(32);
    // Parenting it to a run root that will never be emitted would orphan it.
    expect(span.parentSpanId).toBeUndefined();
  });

  it("carries the GenAI attributes from the log mapping", () => {
    const span = toSpan(
      makeEvent("llm_usage", {
        runId: "run-1",
        provider: "anthropic",
        model: "claude-opus-5",
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      }),
      false,
    );

    const keys = span.attributes.map((attribute) => attribute.key);
    expect(keys).toContain("gen_ai.system");
    expect(keys).toContain("gen_ai.usage.input_tokens");
    expect(keys).toContain("jazz.run.id");
  });
});

describe("isSpanEvent", () => {
  it("excludes agent_run_started, whose span comes from the terminal event", () => {
    expect(isSpanEvent(makeEvent("agent_run_started", {}))).toBe(false);
    expect(isSpanEvent(makeEvent("agent_run_completed", {}))).toBe(true);
  });

  it("excludes command_executed, which would emit a junk trace beside every run", () => {
    expect(isSpanEvent(makeEvent("command_executed", { command: "run" }))).toBe(false);
  });
});

describe("run rollup spans do not double-count usage", () => {
  const usage = { promptTokens: 11654, completionTokens: 237, totalTokens: 11891 };

  it("keeps the run rollup free of GenAI usage attributes", () => {
    const span = toSpan(
      makeEvent("agent_run_completed", {
        runId: "run-1",
        agentName: "researcher",
        provider: "openai",
        model: "gpt-5.4-nano",
        durationMs: 6000,
        usage,
      }),
      false,
    );

    const keys = span.attributes.map((attribute) => attribute.key);
    // Any gen_ai.* on the rollup makes a backend price it as a further LLM call,
    // on top of the per-request spans it summarises.
    expect(keys.filter((key) => key.startsWith("gen_ai."))).toEqual([]);
    // The totals are still reported, just not as semconv usage.
    expect(keys).toContain("jazz.usage.promptTokens");
    expect(keys).toContain("jazz.model");
  });

  it("keeps GenAI usage on the per-request span", () => {
    const span = toSpan(
      makeEvent("llm_usage", {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4-nano",
        durationMs: 3538,
        usage,
      }),
      false,
    );

    const attributes = Object.fromEntries(
      span.attributes.map((attribute) => [attribute.key, Object.values(attribute.value)[0]]),
    );
    expect(attributes["gen_ai.usage.input_tokens"]).toBe("11654");
    expect(attributes["gen_ai.usage.output_tokens"]).toBe("237");
    expect(attributes["gen_ai.request.model"]).toBe("gpt-5.4-nano");
  });

  it("totals across per-request spans equal the rollup, counted once", () => {
    const events = [
      makeEvent(
        "llm_usage",
        { runId: "run-1", model: "gpt-5.4-nano", durationMs: 3538, usage },
        { id: "e1" },
      ),
      makeEvent(
        "llm_usage",
        {
          runId: "run-1",
          model: "gpt-5.4-nano",
          durationMs: 2284,
          usage: { promptTokens: 10819, completionTokens: 58, totalTokens: 10877 },
        },
        { id: "e2" },
      ),
      makeEvent(
        "agent_run_completed",
        {
          runId: "run-1",
          durationMs: 6158,
          usage: { promptTokens: 22473, completionTokens: 295, totalTokens: 22768 },
        },
        { id: "e3" },
      ),
    ];

    const payload = buildTracesPayload(events, {
      serviceName: "jazz",
      serviceVersion: "1.0.0",
      captureContent: false,
    });

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    const billedInput = spans
      .flatMap((span) => span.attributes)
      .filter((attribute) => attribute.key === "gen_ai.usage.input_tokens")
      .reduce((total, attribute) => total + Number(Object.values(attribute.value)[0]), 0);

    // 11654 + 10819 — the rollup's 22473 must not be added a second time.
    expect(billedInput).toBe(22473);
  });
});

describe("buildTracesPayload", () => {
  it("groups a whole run into one trace", () => {
    const events = [
      makeEvent("agent_run_started", { runId: "run-1" }, { id: "e0" }),
      makeEvent("llm_usage", { runId: "run-1", durationMs: 1000 }, { id: "e1" }),
      makeEvent("tool_invocation", { runId: "run-1", durationMs: 200 }, { id: "e2" }),
      makeEvent("agent_run_completed", { runId: "run-1", durationMs: 5000 }, { id: "e3" }),
    ];

    const payload = buildTracesPayload(events, {
      serviceName: "jazz",
      serviceVersion: "1.0.0",
      captureContent: false,
    });

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    // agent_run_started contributes no span of its own.
    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);

    const roots = spans.filter((span) => span.parentSpanId === undefined);
    expect(roots).toHaveLength(1);
  });

  it("is JSON-serialisable", () => {
    const payload = buildTracesPayload([makeEvent("llm_usage", { runId: "run-1" })], {
      serviceName: "jazz",
      serviceVersion: "1.0.0",
      captureContent: false,
    });

    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});
