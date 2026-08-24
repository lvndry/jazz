import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/agent";
import { SchedulerServiceTag, type SchedulerService } from "@/core/workflows/scheduler-service";
import {
  WorkflowServiceTag,
  type WorkflowContent,
  type WorkflowService,
} from "@/core/workflows/workflow-service";
import { runWorkflowCommand } from "./workflow";

/**
 * These tests exercise `runWorkflowCommand`'s exit-code behavior end to end
 * (rather than mocking `@/core/agent/agent-runner` at the module level via
 * `mock.module`, which leaks across test files sharing the same bun test
 * process and breaks unrelated suites that import the real module).
 * `AgentRunner.run` is a plain static method, so it's monkey-patched directly
 * and restored after each test.
 */

const mockAgent: Agent = {
  id: "agent-1",
  name: "ci-reviewer",
  model: "openai/gpt-4o-mini",
  config: {
    persona: "default",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
  },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockWorkflow: WorkflowContent = {
  metadata: {
    name: "code-review",
    description: "Reviews a PR",
    path: "/workflows/code-review",
  },
  prompt: "Review this PR.",
};

const mockTerminal = {
  heading: mock(() => Effect.void),
  info: mock(() => Effect.void),
  log: mock(() => Effect.void),
  success: mock(() => Effect.void),
  error: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  ask: mock(() => Effect.succeed("")),
  confirm: mock(() => Effect.succeed(true)),
} as unknown as TerminalService;

const mockWorkflowService = {
  listWorkflows: mock(() => Effect.succeed([])),
  loadWorkflow: mock(() => Effect.succeed(mockWorkflow)),
} as unknown as WorkflowService;

const mockLogger = {
  debug: mock(() => Effect.void),
  info: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  error: mock(() => Effect.void),
} as unknown as LoggerService;

const mockScheduler = {
  listScheduled: mock(() => Effect.succeed([])),
} as unknown as SchedulerService;

const mockAgentService = {
  getAgent: mock(() => Effect.succeed(mockAgent)),
  listAgents: mock(() => Effect.succeed([mockAgent])),
} as unknown as AgentService;

const testLayer = Layer.mergeAll(
  Layer.succeed(TerminalServiceTag, mockTerminal),
  Layer.succeed(WorkflowServiceTag, mockWorkflowService),
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(SchedulerServiceTag, mockScheduler),
  Layer.succeed(AgentServiceTag, mockAgentService),
  NodeFileSystem.layer,
);

describe("runWorkflowCommand", () => {
  let jazzHomeDir: string;
  let originalJazzHome: string | undefined;
  let originalRun: typeof AgentRunner.run;

  beforeEach(() => {
    process.exitCode = 0;
    originalRun = AgentRunner.run;
    originalJazzHome = process.env["JAZZ_HOME"];
    jazzHomeDir = mkdtempSync(join(tmpdir(), "jazz-workflow-test-"));
    process.env["JAZZ_HOME"] = jazzHomeDir;
  });

  afterEach(() => {
    AgentRunner.run = originalRun;
    if (originalJazzHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = originalJazzHome;
    }
    rmSync(jazzHomeDir, { recursive: true, force: true });
  });

  describe("json mode", () => {
    let stdoutWrites: string[];
    let originalStdoutWrite: typeof process.stdout.write;

    beforeEach(() => {
      stdoutWrites = [];
      originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      (mockTerminal.heading as ReturnType<typeof mock>).mockClear();
      (mockTerminal.log as ReturnType<typeof mock>).mockClear();
    });

    afterEach(() => {
      process.stdout.write = originalStdoutWrite;
    });

    it("emits exactly one ok:true envelope with the answer on stdout and no terminal chatter", async () => {
      AgentRunner.run = mock(() =>
        Effect.succeed({
          content: "the daily review",
          costUSD: 0.12,
          usage: { promptTokens: 100, completionTokens: 50 },
          toolCalls: [],
        }),
      ) as unknown as typeof AgentRunner.run;

      const program = runWorkflowCommand("code-review", {
        autoApprove: true,
        agent: "ci-reviewer",
        json: true,
      });
      const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >;

      await Effect.runPromiseExit(runnable);

      expect(stdoutWrites).toHaveLength(1);
      const envelope = JSON.parse(stdoutWrites[0] as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(true);
      expect(envelope["answer"]).toBe("the daily review");
      expect(envelope["costUSD"]).toBe(0.12);
      expect(envelope["tokenUsage"]).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(process.exitCode).toBe(0);
      expect(mockTerminal.heading).not.toHaveBeenCalled();
      expect(mockTerminal.log).not.toHaveBeenCalled();
    });

    it("emits an ok:false envelope on stdout and exits non-zero when the run fails", async () => {
      AgentRunner.run = mock(() =>
        Effect.fail(new Error("LLMRateLimitError: rate limited")),
      ) as unknown as typeof AgentRunner.run;

      const program = runWorkflowCommand("code-review", {
        autoApprove: true,
        agent: "ci-reviewer",
        json: true,
      });
      const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >;

      await Effect.runPromiseExit(runnable);

      expect(stdoutWrites).toHaveLength(1);
      const envelope = JSON.parse(stdoutWrites[0] as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(false);
      expect(String(envelope["error"])).toContain("rate limited");
      expect(process.exitCode).toBe(1);
    });

    it("aborts a hung run at --timeout and reports it in the envelope", async () => {
      AgentRunner.run = mock(() => Effect.never) as unknown as typeof AgentRunner.run;

      const program = runWorkflowCommand("code-review", {
        autoApprove: true,
        agent: "ci-reviewer",
        json: true,
        timeoutMs: 20,
      });
      const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<
        void,
        unknown,
        never
      >;

      await Effect.runPromiseExit(runnable);

      expect(stdoutWrites).toHaveLength(1);
      const envelope = JSON.parse(stdoutWrites[0] as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(false);
      expect(String(envelope["error"])).toContain("timeout");
      expect(process.exitCode).toBe(1);
    });

    it("fails fast with an envelope when the agent does not exist, without opening the picker", async () => {
      const failingAgentService = {
        getAgent: mock(() => Effect.fail(new Error("not found"))),
        listAgents: mock(() => Effect.succeed([mockAgent])),
      } as unknown as AgentService;
      const layer = Layer.mergeAll(
        Layer.succeed(TerminalServiceTag, mockTerminal),
        Layer.succeed(WorkflowServiceTag, mockWorkflowService),
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(SchedulerServiceTag, mockScheduler),
        Layer.succeed(AgentServiceTag, failingAgentService),
        NodeFileSystem.layer,
      );

      const program = runWorkflowCommand("code-review", { agent: "ghost", json: true });
      const runnable = program.pipe(Effect.provide(layer)) as Effect.Effect<void, unknown, never>;

      await Effect.runPromiseExit(runnable);

      expect(stdoutWrites).toHaveLength(1);
      const envelope = JSON.parse(stdoutWrites[0] as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(false);
      expect(process.exitCode).toBe(1);
    });
  });

  it("sets a non-zero exit code when the agent run fails (e.g. a rate limit error)", async () => {
    const rateLimitError = new Error("LLMRateLimitError: rate limited after 11 retries");
    AgentRunner.run = mock(() => Effect.fail(rateLimitError)) as unknown as typeof AgentRunner.run;

    const program = runWorkflowCommand("code-review", { autoApprove: true, agent: "ci-reviewer" });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;

    await Effect.runPromiseExit(runnable);

    expect(process.exitCode).toBe(1);
  });

  it("forwards --stream to the agent run so --events can emit reasoning off a TTY", async () => {
    let runOptions: Record<string, unknown> | undefined;
    AgentRunner.run = mock((options: Record<string, unknown>) => {
      runOptions = options;
      return Effect.succeed({ content: "ok" });
    }) as unknown as typeof AgentRunner.run;

    const program = runWorkflowCommand("code-review", {
      autoApprove: true,
      agent: "ci-reviewer",
      stream: true,
    });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;

    await Effect.runPromiseExit(runnable);

    expect(runOptions?.["stream"]).toBe(true);
  });

  it("leaves stream unset when neither --stream nor --no-stream is given", async () => {
    let runOptions: Record<string, unknown> | undefined;
    AgentRunner.run = mock((options: Record<string, unknown>) => {
      runOptions = options;
      return Effect.succeed({ content: "ok" });
    }) as unknown as typeof AgentRunner.run;

    const program = runWorkflowCommand("code-review", { autoApprove: true, agent: "ci-reviewer" });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;

    await Effect.runPromiseExit(runnable);

    expect(runOptions).toBeDefined();
    expect("stream" in (runOptions ?? {})).toBe(false);
  });

  it("leaves the exit code untouched when the agent run succeeds", async () => {
    AgentRunner.run = mock(() =>
      Effect.succeed({ content: "ok" }),
    ) as unknown as typeof AgentRunner.run;

    const program = runWorkflowCommand("code-review", { autoApprove: true, agent: "ci-reviewer" });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;

    await Effect.runPromiseExit(runnable);

    expect(process.exitCode).toBe(0);
  });
});
