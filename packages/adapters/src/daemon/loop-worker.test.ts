import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { claimLoopRun, decideLoopControl } from "@jazz/core/agent/loop/loop-lifecycle";
import { newLoop, type LoopRecord } from "@jazz/core/agent/loop/loop-record";
import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import { createRunRecord, type RunRecord } from "@jazz/core/agent/run/run-record";
import type { RunState } from "@jazz/core/agent/run/run-state";
import { silentLogger } from "@jazz/core/agent/test-logger";
import type { AgentResponse, AgentRunnerOptions } from "@jazz/core/agent/types";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { LoopStoreTag } from "@jazz/core/interfaces/loop-store";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { runDueLoops } from "@jazz/adapters/daemon/loop-worker";
import { resumeOwnedRun } from "@jazz/adapters/daemon/resume-owned-run";
import { loadConversation } from "@jazz/adapters/history/conversation-history-service";
import { InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";
import { InMemoryLoopStore } from "@jazz/adapters/storage/loop-store";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";

const AGENT_ID = "agent-1";
const NOT_RUNNING_PID = 999_999_999;

interface Harness {
  loops: InMemoryLoopStore;
  runs: InMemoryRunStore;
  layer: Layer.Layer<never>;
  placedIn: string[];
}

function harness(): Harness {
  const loops = new InMemoryLoopStore();
  const runs = new InMemoryRunStore();
  const placedIn: string[] = [];
  const agents = {
    getAgent: () =>
      Effect.succeed({
        id: AGENT_ID,
        name: "agent",
        config: { llmProvider: "ollama", llmModel: "model" },
      }),
  } as unknown as AgentService;
  const layer = Layer.mergeAll(
    Layer.succeed(LoopStoreTag, loops),
    Layer.succeed(GoalStoreTag, new InMemoryGoalStore()),
    Layer.succeed(RunStoreTag, runs),
    Layer.succeed(AgentServiceTag, agents),
    Layer.succeed(LoggerServiceTag, silentLogger),
    Layer.succeed(AgentConfigServiceTag, {
      appConfig: Effect.succeed({}),
    } as unknown as AgentConfigService),
    Layer.succeed(FileSystemContextServiceTag, {
      setCwd: (_key: unknown, directory: string) =>
        Effect.sync(() => {
          placedIn.push(directory);
        }),
      getCwd: () => Effect.succeed("/work/site"),
    } as unknown as FileSystemContextService),
    NodeFileSystem.layer,
  ) as Layer.Layer<never>;
  return { loops, runs, layer, placedIn };
}

function run<A>(test: Harness, effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(test.layer)) as Effect.Effect<A, unknown>);
}

/** One daemon tick, waiting for any run it started to settle. */
async function tick(test: Harness): Promise<void> {
  const started = await run(test, runDueLoops());
  await Effect.runPromise(Fiber.joinAll(started));
}

async function createLoop(test: Harness, overrides: Partial<LoopRecord> = {}): Promise<LoopRecord> {
  const created = await run(
    test,
    test.loops.create({
      ...newLoop({
        agentId: AGENT_ID,
        name: "deploy-watch",
        prompt: "Check whether the deploy finished.",
        schedule: { kind: "every", everyMs: 10 * 60_000 },
        workingDirectory: "/work/site",
        firstRunAt: new Date(Date.now() - 1_000),
        approvalPolicy: "low-risk",
        budget: { maxTokens: 100_000 },
      }),
      ...overrides,
    }),
  );
  return created;
}

async function current(test: Harness, loopId: string): Promise<LoopRecord> {
  const loop = await run(test, test.loops.get(loopId));
  if (loop === undefined) {
    throw new Error("loop vanished");
  }
  return loop;
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
      conversationId: "loop-chat",
      input: "loop run",
      now: new Date(),
    }),
    state,
    ...spend,
  };
}

function endLoopCall(reason: string): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-end",
          type: "function",
          function: { name: "end_loop", arguments: JSON.stringify({ reason }) },
        },
      ],
    },
    {
      role: "tool",
      name: "end_loop",
      content: JSON.stringify({ success: true, result: { ended: true, reason } }),
      tool_call_id: "call-end",
    },
  ];
}

/** Stand in for AgentRunner.run: record the run the way the real recorder does, then answer. */
function scriptRunner(test: Harness, answer: string, extra: ChatMessage[] = []) {
  const seen: AgentRunnerOptions[] = [];
  const spy = spyOn(AgentRunner, "run").mockImplementation(((options: AgentRunnerOptions) =>
    Effect.gen(function* () {
      seen.push(options);
      const runId = options.runId ?? "unknown";
      yield* test.runs.save(record(runId, { kind: "completed", content: answer }));
      return {
        content: answer,
        conversationId: options.conversationId ?? "loop-chat",
        messages: [
          ...(options.conversationHistory ?? []),
          ...(options.userInput.length > 0 ? [{ role: "user", content: options.userInput }] : []),
          ...extra,
          { role: "assistant", content: answer },
        ],
      } as unknown as AgentResponse;
    })) as unknown as typeof AgentRunner.run);
  return { seen, restore: () => spy.mockRestore() };
}

const APPROVAL = {
  kind: "tool-approval" as const,
  request: {
    toolCallId: "call-edit",
    toolName: "edit_file",
    message: "Edit deploy.yaml",
    executeToolName: "execute_edit_file",
    executeArgs: {},
  },
};

/** A loop whose claimed run parked on an approval. */
async function parkedLoop(test: Harness, overrides: Partial<LoopRecord> = {}): Promise<LoopRecord> {
  const loop = await createLoop(test, overrides);
  const runId = "run-parked";
  const claimed = await run(
    test,
    test.loops.compareAndSet(
      loop.loopId,
      loop.version,
      claimLoopRun(loop, runId, { pid: process.pid, host: hostname() }, new Date()),
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
            { role: "user", content: "Check whether the deploy finished." },
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
  return claimed;
}

let jazzHome: string;
const previousHome = process.env["JAZZ_HOME"];

beforeEach(() => {
  jazzHome = mkdtempSync(join(tmpdir(), "loop-worker-home-"));
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

describe("runDueLoops", () => {
  it("runs a due loop in its directory, under its policy, budget, and the agent loop's own iteration cap", async () => {
    const test = harness();
    const loop = await createLoop(test);
    const runner = scriptRunner(test, "Still deploying.");
    try {
      await tick(test);
    } finally {
      runner.restore();
    }

    expect(test.placedIn).toEqual(["/work/site"]);
    const options = runner.seen[0];
    expect(options?.autoApprovePolicy).toBe("low-risk");
    expect(options?.maxIterations).toBeUndefined();
    expect(options?.maxTokens).toBe(100_000);
    expect(options?.startedBy).toBe("loop");
    expect(options?.userInput).toContain("Check whether the deploy finished.");

    const settled = await current(test, loop.loopId);
    expect(settled.state).toEqual({ kind: "active" });
    expect(settled.run).toBeUndefined();
    expect(settled.usage.runs).toBe(1);
    expect(settled.usage.totalTokens).toBe(1_200);
    expect(settled.lastRun?.summary).toBe("Still deploying.");
    expect(Date.parse(settled.nextRunAt)).toBeGreaterThan(Date.now() + 9 * 60_000);
    const conversation = await run(test, loadConversation(AGENT_ID, loop.conversationId));
    expect(conversation?.messages.at(-1)?.content).toBe("Still deploying.");
  });

  it("starts no run while the daemon is paused, even when due", async () => {
    const test = harness();
    const loop = await createLoop(test);
    const runner = scriptRunner(test, "unused");
    try {
      const started = await run(test, runDueLoops({ startNew: false }));
      await Effect.runPromise(Fiber.joinAll(started));
    } finally {
      runner.restore();
    }
    expect(runner.seen).toHaveLength(0);
    expect((await current(test, loop.loopId)).usage.runs).toBe(0);
  });

  it("does not run a loop before it is due", async () => {
    const test = harness();
    await createLoop(test, { nextRunAt: new Date(Date.now() + 60_000).toISOString() });
    const runner = scriptRunner(test, "unused");
    try {
      await tick(test);
    } finally {
      runner.restore();
    }
    expect(runner.seen).toHaveLength(0);
  });

  it("completes the loop when its run calls end_loop", async () => {
    const test = harness();
    const loop = await createLoop(test);
    const runner = scriptRunner(test, "Deployed.", endLoopCall("The deploy finished."));
    try {
      await tick(test);
    } finally {
      runner.restore();
    }
    expect((await current(test, loop.loopId)).state).toEqual({
      kind: "completed",
      reason: "The deploy finished.",
    });
  });

  it("stops a due loop at a limit it already reached instead of starting a run", async () => {
    const test = harness();
    const loop = await createLoop(test, {
      usage: { runs: 3, totalTokens: 100_000, costKnown: true, costUSD: 0, activeDurationMs: 0 },
    });
    const runner = scriptRunner(test, "unused");
    try {
      await tick(test);
    } finally {
      runner.restore();
    }
    expect(runner.seen).toHaveLength(0);
    expect((await current(test, loop.loopId)).state).toEqual({
      kind: "budget-limited",
      limit: "tokens",
    });
  });

  it("holds the loop while its run waits for approval", async () => {
    const test = harness();
    const loop = await createLoop(test);
    const parkRunner = spyOn(AgentRunner, "run").mockImplementation(((
      options: AgentRunnerOptions,
    ) =>
      Effect.gen(function* () {
        const runId = options.runId ?? "unknown";
        yield* test.runs.save(
          record(runId, {
            kind: "input-required",
            pending: APPROVAL,
            snapshot: { messages: [], iteration: 1 } as never,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        return yield* Effect.fail(
          new RunParkRequested({ pending: APPROVAL, runId, messages: [] } as never),
        );
      })) as unknown as typeof AgentRunner.run);
    try {
      await tick(test);
      await tick(test);
    } finally {
      parkRunner.mockRestore();
    }
    const held = await current(test, loop.loopId);
    expect(held.state).toEqual({ kind: "active" });
    expect(held.run).toBeDefined();
    expect(held.usage.runs).toBe(1);
  });

  it("drops a waiting run once the loop is canceled, keeping its spend", async () => {
    const test = harness();
    const parked = await parkedLoop(test);
    const decision = decideLoopControl(parked, "cancel", new Date());
    if (decision.kind !== "write") {
      throw new Error("cancel refused");
    }
    await run(test, test.loops.compareAndSet(parked.loopId, parked.version, decision.next));

    await tick(test);

    const loop = await current(test, parked.loopId);
    expect(loop.state).toEqual({ kind: "canceled" });
    expect(loop.run).toBeUndefined();
    expect(loop.usage.totalTokens).toBe(1_200);
    expect((await run(test, test.runs.get("run-parked")))?.state.kind).toBe("canceled");
  });

  it("settles a run whose process died as interrupted, and stops after three failures in a row", async () => {
    const test = harness();
    const loop = await createLoop(test, { consecutiveFailures: 2 });
    const claimed = await run(
      test,
      test.loops.compareAndSet(
        loop.loopId,
        loop.version,
        claimLoopRun(loop, "run-dead", { pid: NOT_RUNNING_PID, host: hostname() }, new Date()),
      ),
    );
    await run(
      test,
      test.runs.save(
        record("run-dead", {
          kind: "working",
          iteration: 1,
          owner: { pid: NOT_RUNNING_PID, host: hostname() },
        } as RunState),
      ),
    );

    await tick(test);

    const settled = await current(test, claimed.loopId);
    expect(settled.lastRun?.outcome).toBe("interrupted");
    expect(settled.state.kind).toBe("failed");
    expect((await run(test, test.runs.get("run-dead")))?.state.kind).toBe("failed");
  });

  it("stops rather than runs twice when the run's process is on another host", async () => {
    const test = harness();
    const loop = await createLoop(test);
    await run(
      test,
      test.loops.compareAndSet(
        loop.loopId,
        loop.version,
        claimLoopRun(loop, "run-remote", { pid: 1234, host: "some-other-host" }, new Date()),
      ),
    );

    await tick(test);

    const stopped = await current(test, loop.loopId);
    expect(stopped.state.kind).toBe("failed");
    expect(stopped.run).toBeUndefined();
  });
});

describe("answering a loop's parked run", () => {
  it("finishes the run here, saves it to the loop's conversation, and honors its end_loop", async () => {
    const test = harness();
    const parked = await parkedLoop(test);
    const runner = scriptRunner(test, "Deployed.", endLoopCall("The deploy finished."));
    try {
      const result = await run(
        test,
        resumeOwnedRun({
          runId: "run-parked",
          outcome: { kind: "approval", value: { approved: true } },
        }),
      );
      expect(result.kind).toBe("resumed");
      expect(result.kind === "resumed" ? result.owner : undefined).toEqual({
        loopId: parked.loopId,
      });
    } finally {
      runner.restore();
    }

    expect(runner.seen[0]?.maxTokens).toBe(100_000 - 1_200);
    expect(runner.seen[0]?.startedBy).toBe("loop");
    const loop = await current(test, parked.loopId);
    expect(loop.state).toEqual({ kind: "completed", reason: "The deploy finished." });
    const conversation = await run(test, loadConversation(AGENT_ID, parked.conversationId));
    expect(conversation?.messages.at(-1)?.content).toBe("Deployed.");
  });

  it("drops the run instead when the loop ran out of budget while it waited", async () => {
    const test = harness();
    const parked = await parkedLoop(test, {
      usage: { runs: 0, totalTokens: 99_000, costKnown: true, costUSD: 0, activeDurationMs: 0 },
    });
    const runner = scriptRunner(test, "unused");
    try {
      const result = await run(
        test,
        resumeOwnedRun({
          runId: "run-parked",
          outcome: { kind: "approval", value: { approved: true } },
        }),
      );
      expect(result.kind).toBe("blocked");
    } finally {
      runner.restore();
    }

    expect(runner.seen).toHaveLength(0);
    expect((await current(test, parked.loopId)).state).toEqual({
      kind: "budget-limited",
      limit: "tokens",
    });
    expect((await run(test, test.runs.get("run-parked")))?.state.kind).toBe("canceled");
  });

  it("refuses to answer a run whose loop was asked to stop", async () => {
    const test = harness();
    const parked = await parkedLoop(test);
    const decision = decideLoopControl(parked, "pause", new Date());
    if (decision.kind !== "write") {
      throw new Error("pause refused");
    }
    await run(test, test.loops.compareAndSet(parked.loopId, parked.version, decision.next));

    const result = await run(
      test,
      resumeOwnedRun({
        runId: "run-parked",
        outcome: { kind: "approval", value: { approved: true } },
      }),
    );

    expect(result.kind).toBe("blocked");
  });
});
