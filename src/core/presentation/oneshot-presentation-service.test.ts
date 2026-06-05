import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { StreamingRendererConfig } from "@/core/interfaces/presentation";
import type { StreamEvent } from "@/core/types/streaming";
import { OneShotPresentationService } from "./oneshot-presentation-service";

const rendererConfig: StreamingRendererConfig = {
  displayConfig: DEFAULT_DISPLAY_CONFIG,
  streamingConfig: {},
  showMetrics: false,
  agentName: "test-agent",
};

const toolExecutionStartEvent: StreamEvent = {
  type: "tool_execution_start",
  toolName: "web_search",
  toolCallId: "call_1",
};

const textChunkEvent: StreamEvent = {
  type: "text_chunk",
  delta: "hello",
  accumulated: "hello",
  sequence: 0,
};

describe("OneShotPresentationService streaming renderer", () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  function captureStderr(): { lines: string[] } {
    const captured = { lines: [] as string[] };
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return captured;
  }

  it("emits only events whose type is in the selected set", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
    );
    const renderer = Effect.runSync(service.createStreamingRenderer(rendererConfig));

    const captured = captureStderr();
    Effect.runSync(renderer.handleEvent(toolExecutionStartEvent));
    Effect.runSync(renderer.handleEvent(textChunkEvent));

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(captured.lines[0] as string) as { type: string };
    expect(parsed.type).toBe("tool_execution_start");
  });

  it("returns a noop renderer that writes nothing when no types are selected", () => {
    const service = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());
    const renderer = Effect.runSync(service.createStreamingRenderer(rendererConfig));

    const captured = captureStderr();
    Effect.runSync(renderer.handleEvent(toolExecutionStartEvent));

    expect(captured.lines).toHaveLength(0);
  });

  it("truncates string values longer than 200 characters with an ellipsis", () => {
    const longResult = "x".repeat(500);
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_complete"]),
    );
    const renderer = Effect.runSync(service.createStreamingRenderer(rendererConfig));

    const captured = captureStderr();
    Effect.runSync(
      renderer.handleEvent({
        type: "tool_execution_complete",
        toolCallId: "call_1",
        result: longResult,
        durationMs: 12,
      }),
    );

    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0] as string) as { result: string };
    expect(parsed.result.length).toBe(201);
    expect(parsed.result.endsWith("…")).toBe(true);
    expect(parsed.result.startsWith("x".repeat(200))).toBe(true);
  });

  it("serializes Error-valued event fields to a plain object with a non-empty message", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["error"]),
    );
    const renderer = Effect.runSync(service.createStreamingRenderer(rendererConfig));

    const captured = captureStderr();
    const errorEvent = {
      type: "error",
      error: new Error("model request failed"),
      recoverable: false,
    } as unknown as StreamEvent;
    Effect.runSync(renderer.handleEvent(errorEvent));

    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0] as string) as {
      error: { name: string; message: string };
    };
    expect(parsed.error.message).toBe("model request failed");
    expect(parsed.error.name).toBe("Error");
  });
});

describe("OneShotPresentationService NDJSON stderr purity", () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  function captureStderr(): { lines: string[] } {
    const captured = { lines: [] as string[] };
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return captured;
  }

  it("emits presentWarning as a parseable JSON line when events are active", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["error"]),
    );

    const captured = captureStderr();
    Effect.runSync(service.presentWarning("test-agent", "heads up"));

    expect(captured.lines).toHaveLength(1);
    const line = captured.lines[0] as string;
    expect(line).not.toContain("⚠");
    const parsed = JSON.parse(line) as { type: string; agentName: string; message: string };
    expect(parsed).toEqual({ type: "warning", agentName: "test-agent", message: "heads up" });
  });

  it("emits presentStatus as a parseable JSON line when events are active", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["error"]),
    );

    const captured = captureStderr();
    Effect.runSync(service.presentStatus("working", "progress"));

    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0] as string) as {
      type: string;
      level: string;
      message: string;
    };
    expect(parsed).toEqual({ type: "status", level: "progress", message: "working" });
  });

  it("keeps plain-text warnings when events are not active", () => {
    const service = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());

    const captured = captureStderr();
    Effect.runSync(service.presentWarning("test-agent", "heads up"));

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toBe("⚠ test-agent: heads up\n");
  });
});
