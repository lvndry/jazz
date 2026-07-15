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

const mockAgent = { id: "agent-1", name: "ci-reviewer" } as Agent;

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

  it("sets a non-zero exit code when the agent run fails (e.g. a rate limit error)", async () => {
    const rateLimitError = new Error("LLMRateLimitError: rate limited after 11 retries");
    AgentRunner.run = mock(() => Effect.fail(rateLimitError)) as unknown as typeof AgentRunner.run;

    const program = runWorkflowCommand("code-review", { autoApprove: true, agent: "ci-reviewer" });
    const runnable = program.pipe(Effect.provide(testLayer)) as Effect.Effect<void, unknown, never>;

    await Effect.runPromiseExit(runnable);

    expect(process.exitCode).toBe(1);
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
