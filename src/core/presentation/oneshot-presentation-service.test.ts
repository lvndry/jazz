import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { StreamingRendererConfig } from "@/core/interfaces/presentation";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest } from "@/core/types/tools";
import { detectInteractiveInput, OneShotPresentationService } from "./oneshot-presentation-service";

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

  it("stamps the renderer's agent name on events that carry none", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["text_chunk"]),
    );
    const renderer = Effect.runSync(
      service.createStreamingRenderer({ ...rendererConfig, agentName: "airgap verifier" }),
    );

    const captured = captureStderr();
    Effect.runSync(renderer.handleEvent(textChunkEvent));

    const parsed = JSON.parse(captured.lines[0] as string) as { agentName: string; delta: string };
    expect(parsed.agentName).toBe("airgap verifier");
    expect(parsed.delta).toBe("hello");
  });

  it("keeps an event's own agent name rather than the renderer's", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tools_detected"]),
    );
    const renderer = Effect.runSync(
      service.createStreamingRenderer({ ...rendererConfig, agentName: "parent" }),
    );

    const captured = captureStderr();
    Effect.runSync(
      renderer.handleEvent({
        type: "tools_detected",
        toolNames: ["grep"],
        toolsRequiringApproval: [],
        agentName: "komodo/roles verifier",
      }),
    );

    const parsed = JSON.parse(captured.lines[0] as string) as { agentName: string };
    expect(parsed.agentName).toBe("komodo/roles verifier");
  });

  it("names the agent on status and output lines when the caller knows it", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["text_chunk"]),
    );

    const captured = captureStderr();
    Effect.runSync(
      service.presentStatus("still waiting on the model", "progress", "airgap verifier"),
    );
    Effect.runSync(service.writeOutput("claim 6 holds", "airgap verifier"));

    const [status, output] = captured.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(status?.["type"]).toBe("status");
    expect(status?.["agentName"]).toBe("airgap verifier");
    expect(output?.["type"]).toBe("output");
    expect(output?.["agentName"]).toBe("airgap verifier");
  });

  it("omits agentName rather than guessing when the caller does not know it", () => {
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["text_chunk"]),
    );

    const captured = captureStderr();
    Effect.runSync(service.presentStatus("connecting to the MCP server", "info"));

    const status = JSON.parse(captured.lines[0] as string) as Record<string, unknown>;
    expect("agentName" in status).toBe(false);
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

  it("does not truncate approval_required fields, unlike other event types", () => {
    const longMessage = `Command: ${"x".repeat(500)}\nDescription: something a human needs to read in full before approving`;
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["approval_required"]),
    );
    const renderer = Effect.runSync(service.createStreamingRenderer(rendererConfig));

    const captured = captureStderr();
    Effect.runSync(
      renderer.handleEvent({
        type: "approval_required",
        toolCallId: "call_1",
        toolName: "execute_command",
        message: longMessage,
        riskLevel: "high-risk",
      }),
    );

    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0] as string) as { message: string };
    expect(parsed.message).toBe(longMessage);
    expect(parsed.message).not.toContain("…");
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

describe("OneShotPresentationService.requestUserInput", () => {
  const originalWrite = process.stderr.write;
  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  function captureStderr(): { lines: string[] } {
    const captured = { lines: [] as string[] };
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return captured;
  }

  const request = {
    question: "When is your appointment?",
    suggestions: [
      { value: "today", label: "Today" },
      { value: "tomorrow", label: "Tomorrow" },
    ],
    allowCustom: true,
  };

  it("answers empty without asking when the caller cannot relay a question", async () => {
    // The CI case: --events is on so something is reading the stream, but nothing
    // will ever write an answer back. Asking here would hang the job.
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
      stdin,
      undefined,
      "none",
    );
    const captured = captureStderr();
    const answer = await Effect.runPromise(service.requestUserInput(request));
    expect(answer).toEqual({ kind: "unavailable" });
    // Nothing was emitted, so no consumer is left waiting on a question either.
    expect(captured.lines).toHaveLength(0);
  });

  it("answers empty with no events at all", async () => {
    const service = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());
    expect(await Effect.runPromise(service.requestUserInput(request))).toEqual({
      kind: "unavailable",
    });
  });

  it("emits the question and resolves from a response line on stdin", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
      stdin,
      undefined,
      "protocol",
    );
    const captured = captureStderr();
    const pending = Effect.runPromise(service.requestUserInput(request));
    await tick();

    expect(captured.lines).toHaveLength(1);
    const emitted = JSON.parse(captured.lines[0] as string) as {
      type: string;
      requestId: string;
      question: string;
      suggestions: { value: string }[];
      allowCustom: boolean;
    };
    expect(emitted.type).toBe("user_input_required");
    expect(emitted.question).toBe("When is your appointment?");
    expect(emitted.suggestions.map((s) => s.value)).toEqual(["today", "tomorrow"]);
    expect(emitted.allowCustom).toBe(true);

    stdin.write(
      `${JSON.stringify({
        type: "user_input_response",
        requestId: emitted.requestId,
        response: "tomorrow",
      })}\n`,
    );
    expect(await pending).toEqual({ kind: "answered", response: "tomorrow" });
  });

  it("does not truncate a long question a human has to read", async () => {
    const stdin = new PassThrough();
    const longQuestion = `Which of these should I use? ${"x".repeat(500)}`;
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
      stdin,
      undefined,
      "protocol",
    );
    const captured = captureStderr();
    void Effect.runPromise(service.requestUserInput({ ...request, question: longQuestion }));
    await tick();
    const emitted = JSON.parse(captured.lines[0] as string) as { question: string };
    expect(emitted.question).toBe(longQuestion);
    expect(emitted.question).not.toContain("…");
  });

  it("ignores a response for a question it did not ask", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
      stdin,
      undefined,
      "protocol",
    );
    captureStderr();
    const pending = Effect.runPromise(service.requestUserInput(request));
    await tick();
    stdin.write(
      `${JSON.stringify({ type: "user_input_response", requestId: "ui-999", response: "nope" })}\n`,
    );
    stdin.write("not json at all\n");
    await tick();
    stdin.write(
      `${JSON.stringify({ type: "user_input_response", requestId: "ui-1", response: "today" })}\n`,
    );
    expect(await pending).toEqual({ kind: "answered", response: "today" });
  });

  it("keeps concurrent questions apart", async () => {
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set<StreamEvent["type"]>(["tool_execution_start"]),
      stdin,
      undefined,
      "protocol",
    );
    const captured = captureStderr();
    const first = Effect.runPromise(service.requestUserInput(request));
    const second = Effect.runPromise(
      service.requestUserInput({ ...request, question: "And the other one?" }),
    );
    await tick();
    const ids = captured.lines.map((line) => (JSON.parse(line) as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
    stdin.write(
      `${JSON.stringify({ type: "user_input_response", requestId: ids[1], response: "second" })}\n`,
    );
    stdin.write(
      `${JSON.stringify({ type: "user_input_response", requestId: ids[0], response: "first" })}\n`,
    );
    expect(await first).toEqual({ kind: "answered", response: "first" });
    expect(await second).toEqual({ kind: "answered", response: "second" });
  });
});

describe("detectInteractiveInput", () => {
  it("recognises a terminal without being told", () => {
    // The case that should not need a flag: someone running jazz by hand.
    expect(detectInteractiveInput(false, {}, { isTTY: true })).toEqual({
      interactive: true,
      viaTty: true,
    });
  });

  it("takes the caller's word when stdin is a pipe", () => {
    // A bridge looks exactly like a cron job from here, so it has to say so.
    expect(detectInteractiveInput(true, {}, { isTTY: false })).toEqual({
      interactive: true,
      viaTty: false,
    });
  });

  it("is off for a pipe with nobody declared", () => {
    expect(detectInteractiveInput(false, {}, { isTTY: false })).toEqual({
      interactive: false,
      viaTty: false,
    });
  });

  it("ignores a TTY in CI, where a runner may allocate one anyway", () => {
    expect(detectInteractiveInput(false, { CI: "true" }, { isTTY: true })).toEqual({
      interactive: false,
      viaTty: false,
    });
  });

  it("still honours an explicit declaration in CI", () => {
    // Someone wiring a bridge inside a pipeline meant it.
    expect(detectInteractiveInput(true, { CI: "1" }, { isTTY: true }).interactive).toBe(true);
  });
});

describe("OneShotPresentationService.requestUserInput on a terminal", () => {
  const originalWrite = process.stderr.write;
  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  function captureStderr(): { lines: string[] } {
    const captured = { lines: [] as string[] };
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return captured;
  }

  const request = {
    question: "Which database?",
    suggestions: [
      { value: "postgres", label: "Postgres", description: "the default" },
      { value: "sqlite", label: "SQLite" },
    ],
    allowCustom: true,
  };

  function ttyService(stdin: PassThrough) {
    return new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      new Set(),
      stdin,
      undefined,
      "tty",
    );
  }

  it("prints a readable prompt instead of NDJSON", async () => {
    const stdin = new PassThrough();
    const captured = captureStderr();
    void Effect.runPromise(ttyService(stdin).requestUserInput(request));
    await tick();
    const prompt = captured.lines.join("");
    expect(prompt).toContain("❓ Which database?");
    expect(prompt).toContain("1) Postgres — the default");
    expect(prompt).toContain("2) SQLite");
    expect(prompt).not.toContain("user_input_required");
  });

  it("takes a typed line as the answer", async () => {
    const stdin = new PassThrough();
    captureStderr();
    const pending = Effect.runPromise(ttyService(stdin).requestUserInput(request));
    await tick();
    stdin.write("something of my own\n");
    expect(await pending).toEqual({ kind: "answered", response: "something of my own" });
  });

  it("maps a typed number onto the option it names", async () => {
    const stdin = new PassThrough();
    captureStderr();
    const pending = Effect.runPromise(ttyService(stdin).requestUserInput(request));
    await tick();
    stdin.write("2\n");
    // The agent gets the option's value, not the digit the human typed.
    expect(await pending).toEqual({ kind: "answered", response: "sqlite" });
  });

  it("keeps a number that names no option as literal text", async () => {
    const stdin = new PassThrough();
    captureStderr();
    const pending = Effect.runPromise(ttyService(stdin).requestUserInput(request));
    await tick();
    stdin.write("2026\n");
    expect(await pending).toEqual({ kind: "answered", response: "2026" });
  });

  it("needs no --events, unlike the bridge protocol", async () => {
    // A terminal run has no consumer parsing an event stream.
    const stdin = new PassThrough();
    captureStderr();
    const pending = Effect.runPromise(ttyService(stdin).requestUserInput(request));
    await tick();
    stdin.write("postgres\n");
    expect(await pending).toEqual({ kind: "answered", response: "postgres" });
  });
});
