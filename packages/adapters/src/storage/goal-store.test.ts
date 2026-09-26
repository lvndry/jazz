import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalRecordInput } from "@jazz/core/agent/goal/goal-record";
import { testProposedGoal } from "@jazz/core/agent/goal/test-fixtures";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { FileGoalStore, InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";

function proposedGoal(goalId: string): GoalRecordInput {
  return testProposedGoal({ goalId, conversationId: `execution-${goalId}` });
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

describe("goal update invariants", () => {
  async function activeGoal(store: InMemoryGoalStore, goalId: string) {
    const created = await Effect.runPromise(store.create(proposedGoal(goalId)));
    return Effect.runPromise(
      store.compareAndSet(created.goalId, created.version, {
        ...created,
        state: { kind: "active" },
        approvedPlanRevision: created.plan.revision,
      }),
    );
  }

  it("refuses to open a cycle without counting it, or to swap one open cycle for another", async () => {
    const store = new InMemoryGoalStore();
    const goal = await activeGoal(store, "goal-cycle");
    const owner = { pid: 1, host: "host" };
    const uncounted = await Effect.runPromiseExit(
      store.compareAndSet(goal.goalId, goal.version, {
        ...goal,
        cycle: { runId: "run-a", owner },
        latestRunId: "run-a",
      }),
    );
    expect(uncounted._tag).toBe("Failure");

    const claimed = await Effect.runPromise(
      store.compareAndSet(goal.goalId, goal.version, {
        ...goal,
        cycle: { runId: "run-a", owner },
        latestRunId: "run-a",
        usage: { ...goal.usage, cycles: 1 },
      }),
    );
    const swapped = await Effect.runPromiseExit(
      store.compareAndSet(claimed.goalId, claimed.version, {
        ...claimed,
        cycle: { runId: "run-b", owner },
        latestRunId: "run-b",
      }),
    );
    expect(swapped._tag).toBe("Failure");
  });

  it("never changes a terminal goal", async () => {
    const store = new InMemoryGoalStore();
    const goal = await activeGoal(store, "goal-done");
    const done = await Effect.runPromise(
      store.compareAndSet(goal.goalId, goal.version, {
        ...goal,
        state: { kind: "completed", summary: "Done" },
      }),
    );
    const rewritten = await Effect.runPromiseExit(
      store.compareAndSet(done.goalId, done.version, {
        ...done,
        state: { kind: "completed", summary: "Something else" },
      }),
    );
    expect(rewritten._tag).toBe("Failure");
  });
});

describe("FileGoalStore", () => {
  it("lists and activates other goals when one record on disk is corrupt", async () => {
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-goals-corrupt-"));
    const store = new FileGoalStore(directory);
    await nodeFs.writeFile(path.join(directory, "broken.json"), "{ not json");
    const created = await Effect.runPromise(store.create(proposedGoal("goal-ok")));
    const active = await Effect.runPromise(
      store.compareAndSet(created.goalId, created.version, {
        ...created,
        state: { kind: "active" },
        approvedPlanRevision: created.plan.revision,
      }),
    );

    const listed = await Effect.runPromise(store.list());
    expect(listed.map((goal) => goal.goalId)).toEqual([active.goalId]);
    expect(await Effect.runPromiseExit(store.get("broken"))).toMatchObject({ _tag: "Failure" });
  });

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
