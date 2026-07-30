import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { StreamingRendererConfig } from "@/core/interfaces/presentation";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest } from "@/core/types/tools";
import { OneShotPresentationService } from "./oneshot-presentation-service";

function makeApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: "call_1",
    toolName: "execute_command",
    message: "Run `rm -rf /tmp/scratch`",
    executeToolName: "execute_command_run",
    executeArgs: {},
    ...overrides,
  };
}

/** Wait for one macrotask tick — long enough for any pending microtasks (e.g.
 * Effect's fiber scheduling the `Effect.async` registration) to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

describe("OneShotPresentationService requestApproval", () => {
  it("declines instantly with the exact regression message when no events are active", async () => {
    const service = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());

    const outcome = await Effect.runPromise(
      service.requestApproval(makeApprovalRequest({ toolName: "execute_command" })),
    );

    expect(outcome).toEqual({
      approved: false,
      userMessage:
        `The "execute_command" tool requires approval and was automatically declined ` +
        `because this is a non-interactive run. Do not ask the user to approve or retry — ` +
        `there is no one to respond. Either accomplish the task using tools that do not ` +
        `require approval, or clearly explain what could not be done and why.`,
    });
  });

  it("resolves with the approved value once a matching approval_decision line arrives on stdin", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["approval_required"]),
      stdin,
    );

    const pending = Effect.runPromise(
      service.requestApproval(makeApprovalRequest({ toolCallId: "call_1" })),
    );
    await tick();

    stdin.write(
      `${JSON.stringify({ type: "approval_decision", toolCallId: "call_1", approved: true })}\n`,
    );

    expect(await pending).toEqual({ approved: true });
  });

  it("resolves with approved: false when the decision line says so", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["approval_required"]),
      stdin,
    );

    const pending = Effect.runPromise(
      service.requestApproval(makeApprovalRequest({ toolCallId: "call_1" })),
    );
    await tick();

    stdin.write(
      `${JSON.stringify({ type: "approval_decision", toolCallId: "call_1", approved: false })}\n`,
    );

    expect(await pending).toEqual({ approved: false });
  });

  it("ignores malformed or non-matching lines without resolving the wrong pending entry", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["approval_required"]),
      stdin,
    );

    const pendingA = Effect.runPromise(
      service.requestApproval(makeApprovalRequest({ toolCallId: "call_a", toolName: "tool_a" })),
    );
    const pendingB = Effect.runPromise(
      service.requestApproval(makeApprovalRequest({ toolCallId: "call_b", toolName: "tool_b" })),
    );
    await tick();

    // Malformed JSON and a well-formed line for an unrelated toolCallId: both ignored.
    stdin.write("not json at all\n");
    stdin.write(
      `${JSON.stringify({ type: "approval_decision", toolCallId: "call_unknown", approved: true })}\n`,
    );
    // Missing "approved" field: also ignored.
    stdin.write(`${JSON.stringify({ type: "approval_decision", toolCallId: "call_a" })}\n`);
    await tick();

    // Now resolve call_b only — call_a must remain untouched by the noise above.
    stdin.write(
      `${JSON.stringify({ type: "approval_decision", toolCallId: "call_b", approved: false })}\n`,
    );
    expect(await pendingB).toEqual({ approved: false });

    stdin.write(
      `${JSON.stringify({ type: "approval_decision", toolCallId: "call_a", approved: true })}\n`,
    );
    expect(await pendingA).toEqual({ approved: true });
  });
});
