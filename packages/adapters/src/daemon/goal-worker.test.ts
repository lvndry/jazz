import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import type { GoalRecord, GoalRecordInput } from "@jazz/core/agent/goal/goal-record";
import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import { createRunRecord, type RunRecord } from "@jazz/core/agent/run/run-record";
import type { RunState } from "@jazz/core/agent/run/run-state";
import type { AgentResponse, AgentRunnerOptions } from "@jazz/core/agent/types";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { resumeGoalAwareRun, runDueGoals } from "@jazz/adapters/daemon/goal-worker";
import { loadConversation } from "@jazz/adapters/history/conversation-history-service";
import { InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";

const GOAL_ID = "goal-1";
const AGENT_ID = "agent-1";

function acceptedGoal(overrides: Partial<GoalRecordInput> = {}): GoalRecordInput {
  return {
    goalId: GOAL_ID,
    ownerInstanceId: "owner",
    agentId: AGENT_ID,
    sourceConversationId: "chat",
    conversationId: "goal-chat",
    request: "Make the header test pass",
    plan: {
      revision: 1,
      objective: "Header test passes",
      successCriteria: ["The header test passes"],
      constraints: [],
      assumptions: [],
      feasibility: { assessment: "plausible", rationale: "Small change." },
      steps: [
        { id: "fix", objective: "Fix parser", successCriteria: ["Test passes"], state: "pending" },
      ],
      verification: ["bun test"],
    },
    approvedPlanRevision: 1,
    state: { kind: "active" },
    budget: { maxCycles: 5, maxTokens: 100_000, maxDurationMs: 600_000 },
    usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: false },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  goals: InMemoryGoalStore;
  runs: InMemoryRunStore;
  layer: Layer.Layer<never>;
  prompts: AgentRunnerOptions[];
}

const silentLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

function harness(repair?: string): Harness {
  const goals = new InMemoryGoalStore();
  const runs = new InMemoryRunStore();
  const agents = {
    getAgent: () =>
      Effect.succeed({
        id: AGENT_ID,
        name: "agent",
        config: { llmProvider: "ollama", llmModel: "model" },
      }),
  } as unknown as AgentService;
  const llm = {
    createChatCompletion: () =>
      repair === undefined
        ? Effect.fail(new Error("no repair in this test"))
        : Effect.succeed({ id: "r", model: "model", content: repair, usage: { totalTokens: 7 } }),
  } as unknown as LLMService;
  const layer = Layer.mergeAll(
    Layer.succeed(GoalStoreTag, goals),
    Layer.succeed(RunStoreTag, runs),
    Layer.succeed(AgentServiceTag, agents),
    Layer.succeed(LLMServiceTag, llm),
    Layer.succeed(LoggerServiceTag, silentLogger),
    NodeFileSystem.layer,
  ) as Layer.Layer<never>;
  return { goals, runs, layer, prompts: [] };
}

function run<A>(test: Harness, effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(test.layer)) as Effect.Effect<A, unknown>);
}

function record(
  runId: string,
  state: RunState,
  spend = { totalTokens: 1_200, activeDurationMs: 3_000 },
): RunRecord {
  return {
    ...createRunRecord({
      runId,
      agentId: AGENT_ID,
      conversationId: "goal-chat",
      input: "cycle",
      now: new Date(),
    }),
    state,
    ...spend,
  };
}

const TOOL_OUTPUT = "tests/header.test.ts:\n 1 pass\n 0 fail";

function cycleTranscript(options: AgentRunnerOptions, finalAnswer: string): ChatMessage[] {
  return [
    ...(options.conversationHistory ?? []),
    { role: "user", content: options.userInput },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "execute_command", arguments: "{}" } },
      ],
    },
    { role: "tool", name: "execute_command", content: TOOL_OUTPUT, tool_call_id: "call-1" },
    { role: "assistant", content: finalAnswer },
  ];
}

/** Stand in for AgentRunner.run: record the run the way the real recorder does, then answer. */
function scriptRunner(test: Harness, finalAnswer: string) {
  return spyOn(AgentRunner, "run").mockImplementation(((options: AgentRunnerOptions) =>
    Effect.gen(function* () {
      test.prompts.push(options);
      const runId = options.runId ?? "unknown";
      yield* test.runs.save(record(runId, { kind: "completed", content: finalAnswer }));
      return {
        content: finalAnswer,
        conversationId: options.conversationId ?? "goal-chat",
        messages: cycleTranscript(options, finalAnswer),
      } as unknown as AgentResponse;
    })) as unknown as typeof AgentRunner.run);
}

const COMPLETE = JSON.stringify({
  status: "complete",
  summary: "Header test passes.",
  evidence: [{ criterion: 1, quote: "1 pass 0 fail" }],
});
const CONTINUE = JSON.stringify({
  status: "continue",
  summary: "Fixed the parser.",
  nextAction: "Run the full suite.",
  completedStepIds: ["fix"],
});

let jazzHome: string;
const previousHome = process.env["JAZZ_HOME"];

beforeEach(() => {
  jazzHome = mkdtempSync(join(tmpdir(), "goal-worker-home-"));
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousHome;
  }
  rmSync(jazzHome, { recursive: true, force: true });
});

async function current(test: Harness): Promise<GoalRecord> {
  const goal = await run(
    test,
    Effect.flatMap(GoalStoreTag, (store) => store.get(GOAL_ID)),
  );
  if (goal === undefined) {
    throw new Error("goal vanished");
  }
  return goal;
}

describe("runDueGoals", () => {
  it("runs a due cycle, checks its evidence, and completes the goal with the run's spend", async () => {
    const test = harness();
    await run(test, test.goals.create(acceptedGoal()));
    const runner = scriptRunner(test, COMPLETE);
    try {
      await run(test, runDueGoals());
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state).toEqual({ kind: "completed", summary: "Header test passes." });
    expect(goal.cycle).toBeUndefined();
    expect(goal.usage).toMatchObject({ cycles: 1, totalTokens: 1_200, activeDurationMs: 3_000 });
    expect(goal.evidence?.items).toEqual([
      { criterion: "The header test passes", quote: "1 pass 0 fail" },
    ]);
    expect(test.prompts[0]?.userInput).toContain("1. The header test passes");
  });

  it("records step progress on continue and feeds it to the next cycle", async () => {
    const test = harness();
    await run(test, test.goals.create(acceptedGoal()));
    const runner = scriptRunner(test, CONTINUE);
    try {
      await run(test, runDueGoals());
      expect((await current(test)).state).toEqual({ kind: "active" });
      await run(test, runDueGoals());
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.usage.cycles).toBe(2);
    expect(goal.plan.steps[0]?.state).toBe("completed");
    expect(test.prompts[1]?.userInput).toContain("Fixed the parser.");
    const transcript = await run(test, loadConversation(AGENT_ID, "goal-chat"));
    expect(transcript?.messages.length).toBeGreaterThan(4);
  });

  it("repairs an unstructured answer once, and never accepts evidence the tools did not show", async () => {
    const fabricated = JSON.stringify({
      status: "complete",
      summary: "Done.",
      evidence: [{ criterion: 1, quote: "all 12 tests passed" }],
    });
    const test = harness(fabricated);
    await run(test, test.goals.create(acceptedGoal()));
    const runner = scriptRunner(test, "I fixed it and everything works now!");
    try {
      await run(test, runDueGoals());
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state.kind).toBe("review-required");
    expect(goal.usage.totalTokens).toBe(1_207);
  });

  it("parks on an approval, then a failed resume settles the cycle with its spend", async () => {
    const test = harness();
    await run(test, test.goals.create(acceptedGoal()));
    const pending = {
      kind: "tool-approval" as const,
      request: {
        toolCallId: "call-1",
        toolName: "execute_command",
        message: "rm -rf build",
        executeToolName: "execute_execute_command",
        executeArgs: {},
      },
    };
    const parkRunner = spyOn(AgentRunner, "run").mockImplementation(((
      options: AgentRunnerOptions,
    ) =>
      Effect.gen(function* () {
        const runId = options.runId ?? "unknown";
        yield* test.runs.save(
          record(runId, {
            kind: "input-required",
            pending,
            snapshot: { messages: [], iteration: 1 } as never,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        return yield* Effect.fail(new RunParkRequested({ pending, runId, messages: [] } as never));
      })) as unknown as typeof AgentRunner.run);
    try {
      await run(test, runDueGoals());
    } finally {
      parkRunner.mockRestore();
    }
    const parked = await current(test);
    expect(parked.state).toEqual({ kind: "awaiting-input", reason: "approval" });
    const runId = parked.cycle?.runId ?? "";

    await run(
      test,
      test.runs.save(
        record(runId, { kind: "failed", cause: "error", error: "Operation timed out" }),
      ),
    );
    await run(test, runDueGoals());

    const settled = await current(test);
    expect(settled.state.kind).toBe("review-required");
    expect(settled.cycle).toBeUndefined();
    expect(settled.usage.totalTokens).toBe(1_200);
  });

  it("sends a cycle whose worker died mid-run to review instead of replaying it", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        acceptedGoal({
          cycle: {
            runId: "run-dead",
            owner: { pid: 999_999_999, host: hostname() },
            historyStart: 0,
          },
          latestRunId: "run-dead",
          usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );
    await run(
      test,
      test.runs.save(
        record("run-dead", {
          kind: "working",
          iteration: 2,
          owner: { pid: 999_999_999, host: hostname() },
        }),
      ),
    );
    const runner = scriptRunner(test, COMPLETE);
    try {
      await run(test, runDueGoals());
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state.kind).toBe("review-required");
    expect(test.prompts).toHaveLength(0);
  });

  it("stops at the cycle cap without starting another run", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        acceptedGoal({
          usage: { cycles: 5, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );
    const runner = scriptRunner(test, COMPLETE);
    try {
      await run(test, runDueGoals());
    } finally {
      runner.mockRestore();
    }

    expect((await current(test)).state).toEqual({ kind: "budget-limited", limit: "cycles" });
    expect(test.prompts).toHaveLength(0);
  });
});

describe("resumeGoalAwareRun", () => {
  it("refuses to answer the run of a paused goal", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        acceptedGoal({
          state: { kind: "paused" },
          cycle: {
            runId: "run-parked",
            owner: { pid: process.pid, host: hostname() },
            historyStart: 0,
          },
          latestRunId: "run-parked",
          usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );

    const result = await run(
      test,
      resumeGoalAwareRun({
        runId: "run-parked",
        outcome: { kind: "approval", value: { approved: true } },
      }),
    );

    expect(result.kind).toBe("blocked");
  });
});
