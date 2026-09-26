import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { decidePause } from "@jazz/core/agent/goal/goal-controls";
import type { GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { testGoal } from "@jazz/core/agent/goal/test-fixtures";
import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import { createRunRecord, type RunRecord } from "@jazz/core/agent/run/run-record";
import type { RunState } from "@jazz/core/agent/run/run-state";
import { silentLogger } from "@jazz/core/agent/test-logger";
import type { AgentResponse, AgentRunnerOptions } from "@jazz/core/agent/types";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { resumeGoalAwareRun, runDueGoals } from "@jazz/adapters/daemon/goal-worker";
import { loadConversation } from "@jazz/adapters/history/conversation-history-service";
import { InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";

const GOAL_ID = "goal-1";
const AGENT_ID = "agent-1";

interface Harness {
  goals: InMemoryGoalStore;
  runs: InMemoryRunStore;
  layer: Layer.Layer<never>;
  prompts: AgentRunnerOptions[];
}

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
    Layer.succeed(FileSystemContextServiceTag, {
      setCwd: (key: { conversationId?: string }, directory: string) =>
        Effect.sync(() => {
          placedIn.push({ conversationId: key.conversationId ?? "", directory });
        }),
      getCwd: () => Effect.succeed("/work/importer"),
    } as unknown as FileSystemContextService),
    NodeFileSystem.layer,
  ) as Layer.Layer<never>;
  return { goals, runs, layer, prompts: [] };
}

function run<A>(test: Harness, effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(test.layer)) as Effect.Effect<A, unknown>);
}

/** One daemon tick, waiting for any cycle it started to settle. */
async function tick(test: Harness): Promise<void> {
  const started = await run(test, runDueGoals());
  await Effect.runPromise(Fiber.joinAll(started));
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

/** Where the worker put each conversation before running it. */
const placedIn: { conversationId: string; directory: string }[] = [];

describe("runDueGoals", () => {
  /**
   * The regression: a cycle ran in whatever directory the daemon started from, so a goal
   * accepted in one project read and changed another.
   */
  it("runs every cycle in the directory the goal works in", async () => {
    placedIn.length = 0;
    const test = harness();
    await run(test, test.goals.create(testGoal({ workingDirectory: "/work/other-project" })));
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }
    expect(placedIn).toContainEqual({
      conversationId: "goal-chat",
      directory: "/work/other-project",
    });
  });

  it("runs a due cycle, checks its evidence, and completes the goal with the run's spend", async () => {
    const test = harness();
    await run(test, test.goals.create(testGoal()));
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
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

  it("runs each cycle under the approval policy granted when the goal was accepted", async () => {
    const test = harness();
    await run(test, test.goals.create(testGoal({ approvalPolicy: "high-risk" })));
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }
    expect(test.prompts[0]?.autoApprovePolicy).toBe("high-risk");
  });

  it("grants no extra authority when the goal was accepted without a policy", async () => {
    const test = harness();
    await run(test, test.goals.create(testGoal()));
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }
    expect(test.prompts[0]?.autoApprovePolicy).toBeUndefined();
  });

  it("records step progress on continue and feeds it to the next cycle", async () => {
    const test = harness();
    await run(test, test.goals.create(testGoal()));
    const runner = scriptRunner(test, CONTINUE);
    try {
      await tick(test);
      expect((await current(test)).state).toEqual({ kind: "active" });
      await tick(test);
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
    await run(test, test.goals.create(testGoal()));
    const runner = scriptRunner(test, "I fixed it and everything works now!");
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state).toEqual({ kind: "active" });
    expect(goal.unverifiedClaims).toBe(1);
    expect(goal.lastProgress).toContain("not accepted");
    expect(goal.usage.totalTokens).toBe(1_207);
  });

  it("parks on an approval, then a failed resume settles the cycle with its spend", async () => {
    const test = harness();
    await run(test, test.goals.create(testGoal()));
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
      await tick(test);
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
    await tick(test);

    const settled = await current(test);
    expect(settled.state.kind).toBe("review-required");
    expect(settled.cycle).toBeUndefined();
    expect(settled.usage.totalTokens).toBe(1_200);
  });

  it("continues a cycle whose worker died mid-run in a fresh run told to check the state", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        testGoal({
          cycle: {
            runId: "run-dead",
            owner: { pid: 999_999_999, host: hostname() },
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
      await tick(test);
      const settled = await current(test);
      expect(settled.state.kind).toBe("active");
      expect(settled.cycle).toBeUndefined();
      expect(settled.interruptedCycles).toBe(1);
      expect(test.prompts).toHaveLength(0);
      expect((await run(test, test.runs.get("run-dead")))?.state).toMatchObject({
        kind: "failed",
        cause: "interrupted",
      });

      await tick(test);
    } finally {
      runner.mockRestore();
    }

    expect(test.prompts).toHaveLength(1);
    expect(test.prompts[0]?.userInput).toContain("Check the current state before redoing anything");
    expect((await current(test)).latestRunId).not.toBe("run-dead");
  });

  async function workingCycle(
    test: Harness,
    owner: { pid: number; host: string; startedAt?: number },
  ) {
    await run(
      test,
      test.goals.create(
        testGoal({
          cycle: { runId: "run-elsewhere", owner },
          latestRunId: "run-elsewhere",
          usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );
    await run(
      test,
      test.runs.save(record("run-elsewhere", { kind: "working", iteration: 2, owner })),
    );
  }

  /**
   * The regression: an owner whose host did not match was declared dead, so a hostname change
   * mid-cycle started a second cycle beside the one still running.
   */
  it("stops for review, never replays, when the cycle's process cannot be checked from here", async () => {
    const test = harness();
    await workingCycle(test, { pid: process.pid, host: `${hostname()}-renamed` });
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
      await tick(test);
    } finally {
      runner.mockRestore();
    }
    const goal = await current(test);
    expect(goal.state.kind).toBe("review-required");
    expect(goal.cycle).toBeUndefined();
    expect(test.prompts).toHaveLength(0);
  });

  /** The regression: a reused pid kept a crashed cycle looking alive, and cancel could not end it. */
  it("treats a live pid with another start time as a crashed cycle", async () => {
    const test = harness();
    await workingCycle(test, { pid: process.ppid, host: hostname(), startedAt: 1 });
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }
    const goal = await current(test);
    expect(goal.state.kind).toBe("active");
    expect(goal.interruptedCycles).toBe(1);
    expect((await run(test, test.runs.get("run-elsewhere")))?.state).toMatchObject({
      kind: "failed",
      cause: "interrupted",
    });
  });

  /** The regression: a run left `submitted` by a dead process kept its goal active forever. */
  it("settles a cycle whose run was submitted by a process that then died", async () => {
    const test = harness();
    const owner = { pid: 999_999_999, host: hostname() };
    await run(
      test,
      test.goals.create(
        testGoal({
          cycle: { runId: "run-submitted", owner },
          latestRunId: "run-submitted",
          usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );
    await run(test, test.runs.save(record("run-submitted", { kind: "submitted" })));

    await tick(test);

    expect((await current(test)).state.kind).toBe("review-required");
    expect((await run(test, test.runs.get("run-submitted")))?.state.kind).toBe("failed");
  });

  it("stops at the cycle cap without starting another run", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        testGoal({
          usage: { cycles: 5, totalTokens: 0, activeDurationMs: 0, costKnown: false },
        }),
      ),
    );
    const runner = scriptRunner(test, COMPLETE);
    try {
      await tick(test);
    } finally {
      runner.mockRestore();
    }

    expect((await current(test)).state).toEqual({ kind: "budget-limited", limit: "cycles" });
    expect(test.prompts).toHaveLength(0);
  });
});

const APPROVAL = {
  kind: "tool-approval" as const,
  request: {
    toolCallId: "call-edit",
    toolName: "edit_file",
    message: "edit src/slug.js",
    executeToolName: "execute_edit_file",
    executeArgs: {},
  },
};

/** A goal awaiting approval on a parked cycle run, the state a user answers from. */
async function parkedGoal(test: Harness): Promise<string> {
  const runId = "run-parked";
  const prompt = `[goal cycle ${runId}]\nContinue the goal.`;
  await run(
    test,
    test.goals.create(
      testGoal({
        state: { kind: "awaiting-input", reason: "approval" },
        cycle: { runId, owner: { pid: process.pid, host: hostname() } },
        latestRunId: runId,
        usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: false },
      }),
    ),
  );
  await run(
    test,
    test.runs.save(
      record(runId, {
        kind: "input-required",
        pending: APPROVAL,
        snapshot: {
          iteration: 1,
          messages: [
            { role: "user", content: prompt },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-edit",
                  type: "function",
                  function: { name: "edit_file", arguments: "{}" },
                },
              ],
            },
          ],
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ),
  );
  return runId;
}

/** Stand in for the resumed AgentRunner.run: optionally act mid-run, record completion, answer. */
function resumedRunner(test: Harness, finalAnswer: string, midRun?: () => Promise<void>) {
  return spyOn(AgentRunner, "run").mockImplementation(((options: AgentRunnerOptions) =>
    Effect.gen(function* () {
      if (midRun !== undefined) {
        yield* Effect.promise(midRun);
      }
      const runId = options.runId ?? "unknown";
      yield* test.runs.save(record(runId, { kind: "completed", content: finalAnswer }));
      return {
        content: finalAnswer,
        conversationId: "goal-chat",
        messages: [
          ...(options.conversationHistory ?? []),
          {
            role: "tool",
            name: "execute_command",
            content: TOOL_OUTPUT,
            tool_call_id: "call-edit",
          },
          { role: "assistant", content: finalAnswer },
        ],
      } as unknown as AgentResponse;
    })) as unknown as typeof AgentRunner.run);
}

describe("answering a goal's parked run", () => {
  /**
   * The regression: a resumed run finished with verified evidence while the goal was still
   * awaiting input, and the goal stayed stuck there because the transition was refused.
   */
  it("completes the goal when the answered run finishes with verified evidence", async () => {
    const test = harness();
    const runId = await parkedGoal(test);
    const runner = resumedRunner(test, COMPLETE);
    try {
      const result = await run(
        test,
        resumeGoalAwareRun({ runId, outcome: { kind: "approval", value: { approved: true } } }),
      );
      expect(result.kind).toBe("resumed");
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state.kind).toBe("completed");
    expect(goal.usage.totalTokens).toBe(1_200);
  });

  /**
   * The regression: the resumed segment loaded the raw agent and no iteration cap, so it
   * could propose a new goal from inside a cycle and ran up to the global default.
   */
  it("keeps the cycle's restrictions for the rest of an answered run", async () => {
    const test = harness();
    const runId = await parkedGoal(test);
    const parked = await run(test, test.runs.get(runId));
    await run(test, test.runs.save({ ...parked!, maxIterations: 24 }));
    const seen: AgentRunnerOptions[] = [];
    const runner = resumedRunner(test, COMPLETE);
    const capture = runner.getMockImplementation()!;
    runner.mockImplementation(((options: AgentRunnerOptions) => {
      seen.push(options);
      return capture(options);
    }) as unknown as typeof AgentRunner.run);
    try {
      await run(
        test,
        resumeGoalAwareRun({ runId, outcome: { kind: "approval", value: { approved: true } } }),
      );
    } finally {
      runner.mockRestore();
    }

    expect(seen[0]?.offersGoalProposals).toBeUndefined();
    expect(seen[0]?.maxIterations).toBe(24);
  });

  /** The regression: a pause while the answered run worked was dropped and cycles went on. */
  it("keeps a pause requested while the answered run is working", async () => {
    const test = harness();
    const runId = await parkedGoal(test);
    const runner = resumedRunner(test, CONTINUE, async () => {
      const goal = await current(test);
      const decision = decidePause(goal);
      if (decision.kind !== "write") {
        throw new Error(decision.reason);
      }
      await run(test, test.goals.compareAndSet(goal.goalId, goal.version, decision.next));
    });
    try {
      await run(
        test,
        resumeGoalAwareRun({ runId, outcome: { kind: "approval", value: { approved: true } } }),
      );
    } finally {
      runner.mockRestore();
    }

    const goal = await current(test);
    expect(goal.state).toEqual({ kind: "paused" });
    expect(goal.plan.steps[0]?.state).toBe("completed");
  });
});

describe("resumeGoalAwareRun", () => {
  it("refuses to answer the run of a paused goal", async () => {
    const test = harness();
    await run(
      test,
      test.goals.create(
        testGoal({
          state: { kind: "paused" },
          cycle: {
            runId: "run-parked",
            owner: { pid: process.pid, host: hostname() },
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
