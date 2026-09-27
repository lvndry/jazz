import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testGoal } from "@jazz/core/agent/goal/test-fixtures";
import { newLoop } from "@jazz/core/agent/loop/loop-record";
import { createRunRecord, type RunRecord } from "@jazz/core/agent/run/run-record";
import type { RunState } from "@jazz/core/agent/run/run-state";
import { silentLogger } from "@jazz/core/agent/test-logger";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { LoopStoreTag } from "@jazz/core/interfaces/loop-store";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { recordSpend } from "@jazz/core/spend/ledger";
import type { AppConfig } from "@jazz/core/types/config";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
  announceWaiting,
  daemonGate,
  listWaiting,
  pauseDaemon,
  resumeDaemon,
} from "@jazz/adapters/daemon/attention";
import { readDaemonState } from "@jazz/adapters/storage/daemon-state-store";
import { InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";
import { InMemoryLoopStore } from "@jazz/adapters/storage/loop-store";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";

interface Harness {
  readonly runs: InMemoryRunStore;
  readonly goals: InMemoryGoalStore;
  readonly loops: InMemoryLoopStore;
  readonly run: <A>(effect: Effect.Effect<A, unknown, unknown>) => Promise<A>;
}

function harness(config: AppConfig = {} as AppConfig): Harness {
  const runs = new InMemoryRunStore();
  const goals = new InMemoryGoalStore();
  const loops = new InMemoryLoopStore();
  const layer = Layer.mergeAll(
    Layer.succeed(RunStoreTag, runs),
    Layer.succeed(GoalStoreTag, goals),
    Layer.succeed(LoopStoreTag, loops),
    Layer.succeed(LoggerServiceTag, silentLogger),
    Layer.succeed(AgentConfigServiceTag, {
      reloadIfChanged: () => Effect.succeed(false),
      appConfig: Effect.succeed({
        notifications: { enabled: false },
        ...config,
      }),
    } as unknown as AgentConfigService),
  ) as Layer.Layer<never>;
  return {
    runs,
    goals,
    loops,
    run: (effect) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<never, unknown>),
  };
}

function record(runId: string, state: RunState, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    ...createRunRecord({
      runId,
      agentId: "agent-1",
      conversationId: "chat-1",
      input: "work",
      now: new Date(),
    }),
    state,
    ...extra,
  };
}

/** One run in the spend ledger, as `AgentRunner.run` records it. */
function spent(options: { unattended: boolean; costUSD?: number; tokens?: number }) {
  return Effect.runPromise(
    recordSpend({
      agentId: "agent-1",
      source: options.unattended ? "workflow" : "chat",
      costUSD: options.costUSD ?? 0,
      costKnown: true,
      tokens: options.tokens ?? 1,
      unattended: options.unattended,
    }),
  );
}

function webhookTarget(port: number | undefined): AppConfig["notify"] {
  return { targets: [{ name: "hook", kind: "webhook", url: `http://127.0.0.1:${String(port)}/` }] };
}

function parkedOn(toolName: string, expiresInMs = 60_000): RunState {
  return {
    kind: "input-required",
    pending: {
      kind: "tool-approval",
      request: {
        toolCallId: `call-${toolName}`,
        toolName,
        message: `About to run ${toolName}`,
        executeToolName: `execute_${toolName}`,
        executeArgs: {},
      },
    },
    snapshot: { messages: [], iteration: 1 },
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

let jazzHome: string;
const previousHome = process.env["JAZZ_HOME"];

beforeEach(() => {
  jazzHome = mkdtempSync(join(tmpdir(), "attention-home-"));
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

describe("listWaiting", () => {
  it("lists a goal's parked run once, named after the goal, and skips an expired park", async () => {
    const test = harness();
    await test.run(
      test.goals.create(
        testGoal({
          ownerInstanceId: getJazzInstanceId(),
          name: "ship-docs",
          state: { kind: "awaiting-input", reason: "approval" },
          cycle: { runId: "run-goal", owner: { pid: process.pid, host: "here" } },
          latestRunId: "run-goal",
        }),
      ),
    );
    await test.run(test.runs.save(record("run-goal", parkedOn("execute_command"))));
    await test.run(test.runs.save(record("run-old", parkedOn("write_file", -1_000))));

    const waiting = await test.run(listWaiting());

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "approval",
      title: "Goal ship-docs wants to use execute_command",
      detail: "About to run execute_command",
      runId: "run-goal",
      goalId: "goal-1",
    });
  });

  it("lists a goal stopped for review and a loop that stopped", async () => {
    const test = harness();
    await test.run(
      test.goals.create(
        testGoal({
          ownerInstanceId: getJazzInstanceId(),
          name: "trip",
          state: { kind: "review-required", reason: "q", question: "Which dates?" },
        }),
      ),
    );
    const loop = await test.run(
      test.loops.create(
        newLoop({
          agentId: "agent-1",
          name: "deploy-watch",
          prompt: "check",
          schedule: { kind: "every", everyMs: 600_000 },
          workingDirectory: "/work",
          firstRunAt: new Date(),
        }),
      ),
    );
    await test.run(
      test.loops.compareAndSet(loop.loopId, loop.version, {
        ...loop,
        state: { kind: "failed", reason: "Its last 3 runs failed." },
      }),
    );

    const waiting = await test.run(listWaiting());

    expect(waiting.map((item) => [item.kind, item.title])).toEqual([
      ["goal-review", "Goal trip has a question"],
      ["loop-stopped", "Loop deploy-watch stopped"],
    ]);
  });
});

describe("daemonGate", () => {
  it("pauses itself at the daily cap, counting only unattended runs in the ledger, and a resume lifts it for the day", async () => {
    const test = harness({ daemon: { dailyCostUSD: 1 } } as AppConfig);
    await spent({ unattended: false, costUSD: 5 });
    expect((await test.run(daemonGate())).kind).toBe("open");

    await spent({ unattended: true, costUSD: 1.2 });
    const gate = await test.run(daemonGate());
    expect(gate).toMatchObject({ kind: "paused", pause: { kind: "daily-cap", limit: "cost" } });
    expect((await test.run(readDaemonState())).paused?.kind).toBe("daily-cap");

    await test.run(resumeDaemon());
    expect((await test.run(daemonGate())).kind).toBe("open");
  });

  /** The regression: a cap set in config while the daemon ran was never read until a restart. */
  it("applies a daily cap set while it runs, on its next check", async () => {
    let current = { notifications: { enabled: false } } as AppConfig;
    const runs = new InMemoryRunStore();
    const layer = Layer.mergeAll(
      Layer.succeed(RunStoreTag, runs),
      Layer.succeed(GoalStoreTag, new InMemoryGoalStore()),
      Layer.succeed(LoopStoreTag, new InMemoryLoopStore()),
      Layer.succeed(LoggerServiceTag, silentLogger),
      Layer.succeed(AgentConfigServiceTag, {
        reloadIfChanged: () => Effect.succeed(true),
        get appConfig() {
          return Effect.sync(() => current);
        },
      } as unknown as AgentConfigService),
    ) as Layer.Layer<never>;
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown>);
    await spent({ unattended: true, tokens: 50 });
    expect((await run(daemonGate())).kind).toBe("open");
    current = { ...current, daemon: { dailyTokens: 10 } };
    expect((await run(daemonGate())).kind).toBe("paused");
  });

  it("stays paused after the user pauses it, until they resume", async () => {
    const test = harness();
    await test.run(pauseDaemon());
    expect(await test.run(daemonGate())).toMatchObject({ kind: "paused", pause: { kind: "user" } });
    await test.run(resumeDaemon());
    expect((await test.run(daemonGate())).kind).toBe("open");
  });
});

describe("announceWaiting", () => {
  it("posts each new item once to the webhook target, with how to answer it", async () => {
    const received: { title: string; body: string; type: string }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push((await request.json()) as { title: string; body: string; type: string });
        return new Response("ok");
      },
    });
    try {
      const test = harness({ notify: webhookTarget(server.port) } as AppConfig);
      await test.run(test.runs.save(record("run-a", parkedOn("execute_command"))));

      await test.run(announceWaiting());
      await test.run(announceWaiting());
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: "waiting",
        title: "A run wants to use execute_command",
      });
      expect(received[0]?.body).toContain("jazz runs approve run-a");

      await test.run(test.runs.save(record("run-b", parkedOn("write_file"))));
      await test.run(announceWaiting());
      expect(received).toHaveLength(2);
    } finally {
      await server.stop(true);
    }
  });

  it("announces a pause at the daily cap once", async () => {
    const received: { type: string }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push((await request.json()) as { type: string });
        return new Response("ok");
      },
    });
    try {
      const test = harness({
        daemon: { dailyTokens: 10 },
        notify: webhookTarget(server.port),
      } as AppConfig);
      await spent({ unattended: true, tokens: 50 });
      await test.run(daemonGate());
      await test.run(announceWaiting());
      await test.run(announceWaiting());
      expect(received.map((event) => event.type)).toEqual(["paused"]);
    } finally {
      await server.stop(true);
    }
  });
});
