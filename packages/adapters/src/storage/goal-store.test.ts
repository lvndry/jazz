import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalRecord } from "@jazz/core/agent/goal/goal-record";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { FileGoalStore, InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";

function proposedGoal(goalId: string): Omit<GoalRecord, "version"> {
  return {
    goalId,
    ownerInstanceId: "owner-a",
    agentId: "agent-a",
    sourceConversationId: "chat-a",
    conversationId: `execution-${goalId}`,
    request: "Improve the evaluation pipeline",
    plan: {
      revision: 1,
      objective: "Improve the evaluation pipeline",
      successCriteria: ["Reports include paired outcomes"],
      constraints: ["Preserve distinct existing tasks"],
      assumptions: [],
      feasibility: { assessment: "plausible", rationale: "The runner can be extended." },
      steps: [
        {
          id: "inventory",
          objective: "Inventory current evaluations",
          successCriteria: ["An inventory exists"],
          state: "pending",
        },
      ],
      verification: ["Run the focused evaluation and inspect its report"],
    },
    state: { kind: "proposed" },
    budget: { maxCycles: 4, maxTokens: 20_000, maxDurationMs: 60_000 },
    usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: false },
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

describe("InMemoryGoalStore", () => {
  it("uses compare-and-set versions and rejects a second active goal in one conversation", async () => {
    const store = new InMemoryGoalStore();
    const first = await Effect.runPromise(store.create(proposedGoal("goal-1")));
    const active = await Effect.runPromise(
      store.compareAndSet(first.goalId, first.version, {
        ...first,
        state: { kind: "active" },
        approvedPlanRevision: first.plan.revision,
      }),
    );
    expect(active.version).toBe(2);

    const second = await Effect.runPromise(store.create(proposedGoal("goal-2")));
    const conflict = await Effect.runPromiseExit(
      store.compareAndSet(second.goalId, second.version, {
        ...second,
        state: { kind: "active" },
        approvedPlanRevision: second.plan.revision,
      }),
    );
    expect(conflict._tag).toBe("Failure");

    const stale = await Effect.runPromiseExit(
      store.compareAndSet(first.goalId, first.version, { ...first, state: { kind: "canceled" } }),
    );
    expect(stale._tag).toBe("Failure");
  });

  it("rejects plan edits that do not advance the revision", async () => {
    const store = new InMemoryGoalStore();
    const goal = await Effect.runPromise(store.create(proposedGoal("goal-plan")));
    const changedPlan = {
      ...goal.plan,
      objective: "A materially different objective",
    };
    const result = await Effect.runPromiseExit(
      store.compareAndSet(goal.goalId, goal.version, { ...goal, plan: changedPlan }),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("FileGoalStore", () => {
  it("persists private goal records and serializes active claims", async () => {
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-goals-"));
    const store = new FileGoalStore(directory);
    const first = await Effect.runPromise(store.create(proposedGoal("goal-file-1")));
    const active = await Effect.runPromise(
      store.compareAndSet(first.goalId, first.version, {
        ...first,
        state: { kind: "active" },
        approvedPlanRevision: first.plan.revision,
      }),
    );
    expect(
      (await Effect.runPromise(new FileGoalStore(directory).get(first.goalId)))?.state,
    ).toEqual({ kind: "active" });

    const second = await Effect.runPromise(store.create(proposedGoal("goal-file-2")));
    const conflict = await Effect.runPromiseExit(
      store.compareAndSet(second.goalId, second.version, {
        ...second,
        state: { kind: "active" },
        approvedPlanRevision: second.plan.revision,
      }),
    );
    expect(conflict._tag).toBe("Failure");
    expect((await nodeFs.stat(path.join(directory, `${active.goalId}.json`))).mode & 0o777).toBe(
      0o600,
    );
  });
});
