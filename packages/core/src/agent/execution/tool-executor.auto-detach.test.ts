/**
 * A slow foreground `execute_command` in an attended run moves to the background at a threshold,
 * keeps its single process, and reports its real outcome later. The registry is a stub whose
 * `execute_command` counts how many times it starts and runs for a set time.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag } from "../../interfaces/agent-config";
import type { AgentConfigService } from "../../interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import {
  PresentationServiceTag,
  type PresentationService,
  type StreamingRenderer,
} from "../../interfaces/presentation";
import { ToolRegistryTag, type ToolRegistry } from "../../interfaces/tool-registry";
import { partialFake, withoutServices } from "../../test-support/fakes";
import type { StreamEvent } from "../../types/streaming";
import type { ToolCall, ToolExecutionContext } from "../../types/tools";
import { createDetachedCallTracker, type AutoDetachPolicy } from "../detach/auto-detach";
import type { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import type { DetachedToolResult } from "../types";
import { ToolExecutor } from "./tool-executor";

const SHORT_THRESHOLD_MS = 30;
const SLOW_COMMAND_MS = 200;

const logger = partialFake<LoggerService>({
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  logToolCall: () => Effect.void,
});

let approvalSignals = 0;

const presentation = partialFake<PresentationService>({
  signalToolExecutionStarted: () =>
    Effect.sync(() => {
      approvalSignals += 1;
    }),
  formatToolsDetected: () => Effect.succeed(""),
  writeOutput: () => Effect.void,
  writeBlankLine: () => Effect.void,
  formatToolExecutionStart: () => Effect.succeed(""),
  formatToolExecutionComplete: () => Effect.succeed(""),
  formatToolResult: () => "",
  formatToolExecutionError: (message: string) => Effect.succeed(message),
});

const agentConfig = partialFake<AgentConfigService>({ appConfig: Effect.succeed({}) });

const runMetrics = partialFake<ReturnType<typeof createAgentRunMetrics>>({
  runId: "run",
  agentId: "agent",
  agentName: "agent",
  toolCalls: 0,
  toolErrors: 0,
  toolsUsed: new Set(),
  toolCallCounts: {},
  toolInvocationSequence: [],
  errors: [],
  iterationSummaries: [],
  totalToolResultTokens: 0,
});

interface FakeShell {
  readonly registry: ToolRegistry;
  readonly starts: () => number;
  readonly interrupted: () => number;
}

function fakeShell(options: {
  readonly runMs: number;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly confinement?: Record<string, unknown>;
  /** Tool names that run for this long instead of `runMs`. */
  readonly runMsByTool?: Readonly<Record<string, number>>;
}): FakeShell {
  let starts = 0;
  let interrupted = 0;
  const registry = partialFake<ToolRegistry>({
    getTool: () => Effect.succeed({ name: "execute_command", timeoutMs: 5_000 }),
    executeTool: (name: string, args: Record<string, unknown>) => {
      starts += 1;
      return Effect.sleep(options.runMsByTool?.[name] ?? options.runMs).pipe(
        Effect.as({
          success: true,
          result: {
            command: args["command"],
            exitCode: options.exitCode ?? 0,
            timedOut: options.timedOut ?? false,
            stdout: options.stdout ?? "",
            stderr: "",
            ...(options.confinement !== undefined ? { confinement: options.confinement } : {}),
          },
          untrusted: { kind: "external", source: "execute_command output" },
        }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted += 1;
          }),
        ),
      );
    },
  });
  return { registry, starts: () => starts, interrupted: () => interrupted };
}

function commandCall(id: string, command: string): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "execute_command", arguments: JSON.stringify({ command }) },
  };
}

function policyWith(overrides: Partial<AutoDetachPolicy> = {}): AutoDetachPolicy {
  return {
    thresholdMs: SHORT_THRESHOLD_MS,
    maxConcurrent: 3,
    tracker: createDetachedCallTracker(),
    ...overrides,
  };
}

async function runBatch(input: {
  readonly shell: FakeShell;
  readonly calls: readonly ToolCall[];
  readonly autoDetach?: AutoDetachPolicy;
  readonly onDetachedToolComplete?: (result: DetachedToolResult) => void;
  readonly renderer?: StreamingRenderer;
  readonly interruptSignal?: Effect.Effect<void, never>;
}) {
  const context: ToolExecutionContext = {
    agentId: "agent",
    conversationId: "conversation",
    unrestrictedTools: true,
    ...(input.autoDetach !== undefined ? { autoDetach: input.autoDetach } : {}),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, logger),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(ToolRegistryTag, input.shell.registry),
    Layer.succeed(AgentConfigServiceTag, agentConfig),
  );
  const program = ToolExecutor.executeToolCalls(
    input.calls,
    context,
    { showReasoning: false, showToolExecution: true, mode: "hybrid" },
    input.renderer ?? null,
    runMetrics,
    "agent",
    "conversation",
    "agent",
    input.interruptSignal,
    undefined,
    input.onDetachedToolComplete,
  ).pipe(Effect.provide(layer));
  return Effect.runPromise(withoutServices(program));
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

describe("automatic detach of a slow foreground shell command", () => {
  it("moves the command to the background after the threshold without starting it twice", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS, exitCode: 0, stdout: "built ok" });
    const completions: DetachedToolResult[] = [];
    const policy = policyWith();
    const startedAt = Date.now();

    const results = await runBatch({
      shell,
      calls: [commandCall("call-1", "make all")],
      autoDetach: policy,
      onDetachedToolComplete: (result) => completions.push(result),
    });

    expect(Date.now() - startedAt).toBeLessThan(SLOW_COMMAND_MS);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.result).toMatchObject({ backgrounded: true, command: "make all" });
    expect(typeof (results[0]?.result as { message: unknown }).message).toBe("string");
    expect(policy.tracker.running()).toHaveLength(1);
    expect(completions).toHaveLength(0);

    await waitMs(SLOW_COMMAND_MS);

    expect(shell.starts()).toBe(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.toolName).toBe("execute_command");
    expect(completions[0]?.summary).toContain("make all");
    expect(completions[0]?.summary).toContain("exited with code 0");
    expect(completions[0]?.summary).toContain("built ok");
    expect(policy.tracker.running()).toHaveLength(0);
  });

  it("shows the move to the background in the transcript", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS });
    const events: StreamEvent[] = [];
    const renderer: StreamingRenderer = {
      handleEvent: (event) => Effect.sync(() => void events.push(event)),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };

    await runBatch({
      shell,
      calls: [commandCall("call-1", "sleep 99")],
      autoDetach: policyWith(),
      onDetachedToolComplete: () => {},
      renderer,
    });

    const moved = events.find(
      (event) => event.type === "tool_execution_complete" && event.backgrounded === true,
    );
    expect(moved).toBeDefined();
    await waitMs(SLOW_COMMAND_MS);
  });

  it("keeps a command that finishes before the threshold in the foreground", async () => {
    const shell = fakeShell({ runMs: 5 });
    const completions: DetachedToolResult[] = [];

    const results = await runBatch({
      shell,
      calls: [commandCall("call-1", "ls")],
      autoDetach: policyWith({ thresholdMs: 150 }),
      onDetachedToolComplete: (result) => completions.push(result),
    });

    expect(results[0]?.result).toMatchObject({ exitCode: 0 });
    expect(results[0]?.result).not.toHaveProperty("backgrounded");
    await waitMs(200);
    expect(completions).toHaveLength(0);
  });

  it("leaves the command in the foreground for a run with no autoDetach policy", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS });
    const completions: DetachedToolResult[] = [];

    const results = await runBatch({
      shell,
      calls: [commandCall("call-1", "make all")],
      onDetachedToolComplete: (result) => completions.push(result),
    });

    expect(results[0]?.result).toMatchObject({ exitCode: 0 });
    expect(shell.starts()).toBe(1);
    expect(completions).toHaveLength(0);
  });

  it("leaves the command in the foreground when nothing can receive a late result", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS });
    const policy = policyWith();

    const results = await runBatch({
      shell,
      calls: [commandCall("call-1", "make all")],
      autoDetach: policy,
    });

    expect(results[0]?.result).toMatchObject({ exitCode: 0 });
    expect(policy.tracker.running()).toHaveLength(0);
  });

  it("keeps a command in the foreground, with a note, once the concurrency limit is reached", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS });
    const completions: DetachedToolResult[] = [];
    const policy = policyWith({ maxConcurrent: 1 });

    const results = await runBatch({
      shell,
      calls: [commandCall("call-1", "first"), commandCall("call-2", "second")],
      autoDetach: policy,
      onDetachedToolComplete: (result) => completions.push(result),
    });

    const detached = results.filter(
      (outcome) => (outcome.result as { backgrounded?: boolean }).backgrounded === true,
    );
    const foreground = results.filter(
      (outcome) => (outcome.result as { backgrounded?: boolean }).backgrounded !== true,
    );
    expect(detached).toHaveLength(1);
    expect(foreground).toHaveLength(1);
    expect(foreground[0]?.result).toMatchObject({ exitCode: 0 });
    expect(typeof (foreground[0]?.result as { backgroundNote: unknown }).backgroundNote).toBe(
      "string",
    );
    expect(shell.starts()).toBe(2);
    await waitMs(SLOW_COMMAND_MS);
    expect(completions).toHaveLength(1);
  });

  it("stops a detached command's process when the tracker stops it", async () => {
    const shell = fakeShell({ runMs: 5_000 });
    const completions: DetachedToolResult[] = [];
    const policy = policyWith();

    await runBatch({
      shell,
      calls: [commandCall("call-1", "sleep 999")],
      autoDetach: policy,
      onDetachedToolComplete: (result) => completions.push(result),
    });
    expect(policy.tracker.running()).toHaveLength(1);

    await Effect.runPromise(policy.tracker.stopAll());
    await waitMs(20);

    expect(shell.interrupted()).toBe(1);
    expect(policy.tracker.running()).toHaveLength(0);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.summary).toContain("was stopped before it finished");
  });

  it("reports a command that reached its time limit as a timeout", async () => {
    const shell = fakeShell({
      runMs: SLOW_COMMAND_MS,
      exitCode: 124,
      timedOut: true,
      stdout: "partial",
    });
    const completions: DetachedToolResult[] = [];

    await runBatch({
      shell,
      calls: [commandCall("call-1", "sleep 9999")],
      autoDetach: policyWith(),
      onDetachedToolComplete: (result) => completions.push(result),
    });
    await waitMs(SLOW_COMMAND_MS);

    expect(completions[0]?.summary).toContain("time limit");
    expect(completions[0]?.summary).toContain("partial");
  });

  it("bounds the output tail a late result carries", async () => {
    const shell = fakeShell({ runMs: SLOW_COMMAND_MS, stdout: `${"x".repeat(10_000)}END` });
    const completions: DetachedToolResult[] = [];

    await runBatch({
      shell,
      calls: [commandCall("call-1", "noisy")],
      autoDetach: policyWith(),
      onDetachedToolComplete: (result) => completions.push(result),
    });
    await waitMs(SLOW_COMMAND_MS);

    const summary = completions[0]?.summary ?? "";
    expect(summary).toContain("END");
    expect(summary.length).toBeLessThan(4_000);
  });

  it("releases the next queued approval prompt as soon as a call is detached", async () => {
    const shell = fakeShell({ runMs: 5_000 });
    const policy = policyWith();
    approvalSignals = 0;

    await runBatch({
      shell,
      calls: [commandCall("call-1", "sleep 999")],
      autoDetach: policy,
      onDetachedToolComplete: () => {},
    });

    expect(policy.tracker.running()).toHaveLength(1);
    expect(approvalSignals).toBeGreaterThan(0);
    await Effect.runPromise(policy.tracker.stopAll());
  });

  it("keeps an auto-detached command running when the batch is interrupted", async () => {
    const shell = fakeShell({ runMs: 5_000, runMsByTool: { read_file: 5_000 } });
    const policy = policyWith();
    const completions: DetachedToolResult[] = [];
    const readCall: ToolCall = {
      id: "call-2",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    };

    const outcome = await runBatch({
      shell,
      calls: [commandCall("call-1", "sleep 999"), readCall],
      autoDetach: policy,
      onDetachedToolComplete: (result) => completions.push(result),
      interruptSignal: Effect.sleep(120),
    }).then(
      () => "completed",
      () => "interrupted",
    );

    expect(outcome).toBe("interrupted");
    expect(shell.interrupted()).toBe(1);
    expect(policy.tracker.running()).toHaveLength(1);
    expect(completions).toHaveLength(0);

    await Effect.runPromise(policy.tracker.stopAll());
    await waitMs(20);
    expect(shell.interrupted()).toBe(2);
    expect(completions[0]?.summary).toContain("was stopped before it finished");
  });

  it("does not exceed the cap when rendering concurrent detach notifications yields", async () => {
    const shell = fakeShell({ runMs: 500 });
    const policy = policyWith({ maxConcurrent: 3 });
    const completions: DetachedToolResult[] = [];
    const results = await runBatch({
      shell,
      autoDetach: policy,
      calls: Array.from({ length: 4 }, (_, index) => commandCall(`cap-${index}`, "build")),
      onDetachedToolComplete: (result) => completions.push(result),
      renderer: {
        handleEvent: (event) =>
          event.type === "tool_execution_complete" && event.backgrounded === true
            ? Effect.sleep(40)
            : Effect.void,
        setInterruptHandler: () => Effect.void,
        reset: () => Effect.void,
        flush: () => Effect.void,
      },
    });
    expect(
      results.filter(
        (outcome) =>
          typeof outcome.result === "object" &&
          outcome.result !== null &&
          "backgrounded" in outcome.result,
      ),
    ).toHaveLength(3);
    expect(shell.starts()).toBe(4);
    await waitMs(20);
    expect(completions).toHaveLength(3);
    expect(policy.tracker.running()).toHaveLength(0);
  });

  it("keeps ownership and its completion watcher when interrupted during the detach notification", async () => {
    const shell = fakeShell({ runMs: 5_000 });
    const policy = policyWith();
    const completions: DetachedToolResult[] = [];
    let notify: (() => void) | undefined;
    const notification = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const renderer: StreamingRenderer = {
      handleEvent: (event) =>
        event.type === "tool_execution_complete" && event.backgrounded === true
          ? Effect.sync(() => notify?.()).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };
    const result = await runBatch({
      shell,
      calls: [commandCall("transfer", "build")],
      autoDetach: policy,
      onDetachedToolComplete: (value) => completions.push(value),
      renderer,
      interruptSignal: Effect.promise(() => notification),
    }).then(
      () => "completed",
      () => "interrupted",
    );
    expect(result).toBe("interrupted");
    expect(shell.interrupted()).toBe(0);
    expect(policy.tracker.running()).toHaveLength(1);
    await Effect.runPromise(policy.tracker.stopAll());
    await waitMs(10);
    expect(shell.interrupted()).toBe(1);
    expect(policy.tracker.running()).toHaveLength(0);
    expect(completions).toHaveLength(1);
  });

  it("reports a natural exit 124 without calling it a timeout", async () => {
    const completions: DetachedToolResult[] = [];
    await runBatch({
      shell: fakeShell({ runMs: SLOW_COMMAND_MS, exitCode: 124 }),
      calls: [commandCall("exit-124", "exit 124")],
      autoDetach: policyWith(),
      onDetachedToolComplete: (value) => completions.push(value),
    });
    await waitMs(SLOW_COMMAND_MS);
    expect(completions[0]?.summary).toContain("exited with code 124");
    expect(completions[0]?.summary).not.toContain("time limit");
  });

  it("releases an approval once across detach and the later completion", async () => {
    approvalSignals = 0;
    await runBatch({
      shell: fakeShell({ runMs: SLOW_COMMAND_MS }),
      calls: [commandCall("one-signal", "build")],
      autoDetach: policyWith(),
      onDetachedToolComplete: () => {},
    });
    expect(approvalSignals).toBe(1);
    await waitMs(SLOW_COMMAND_MS);
    expect(approvalSignals).toBe(1);
  });

  it("carries the confinement guidance of a denied detached command", async () => {
    const shell = fakeShell({
      runMs: SLOW_COMMAND_MS,
      exitCode: 1,
      confinement: { deniedPath: "/etc/hosts", guidance: "GUIDANCE-TEXT-FOR-ESCALATION" },
    });
    const completions: DetachedToolResult[] = [];

    await runBatch({
      shell,
      calls: [commandCall("call-1", "echo x >> /etc/hosts")],
      autoDetach: policyWith(),
      onDetachedToolComplete: (result) => completions.push(result),
    });
    await waitMs(SLOW_COMMAND_MS);

    expect(completions[0]?.summary).toContain("GUIDANCE-TEXT-FOR-ESCALATION");
  });
});
