import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { BLOCKED_ROUNDS_REQUIRED } from "@/core/agent/goal/goal-blocker";
import type { GoalRecord } from "@/core/agent/goal/goal-record";
import { testStoredGoal } from "@/core/agent/goal/test-fixtures";
import { GoalStoreTag, type GoalStore } from "@/core/interfaces/goal-store";
import { partialFake } from "@/core/test-support/fakes";
import { createReportGoalCycleTool } from "./goal-report";

const RUN_ID = "run-1";

function storeHolding(goal: GoalRecord): GoalStore {
  return partialFake<GoalStore>({ list: () => Effect.succeed([goal]) });
}

function report(args: Record<string, unknown>, goal: GoalRecord) {
  return Effect.runPromise(
    createReportGoalCycleTool()
      .execute(args as never, { agentId: "agent-1", runId: RUN_ID })
      .pipe(Effect.provideService(GoalStoreTag, storeHolding(goal))),
  );
}

describe("report_goal_cycle", () => {
  const cycle = { runId: RUN_ID, owner: { pid: 1, host: "host" } };

  it("tells a blocked report that is too early what to do and how many rounds remain", async () => {
    const goal = testStoredGoal({ cycle, latestRunId: RUN_ID });
    const result = await report(
      { status: "blocked", summary: "No access.", blocker: "No access" },
      goal,
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      recorded: true,
      instruction: expect.stringContaining(`round 1 of ${BLOCKED_ROUNDS_REQUIRED}`),
    });
  });

  it("gives no instruction once the same blocker has been reported often enough", async () => {
    const goal = testStoredGoal({
      cycle,
      latestRunId: RUN_ID,
      blockerStreak: { blocker: "no access", rounds: BLOCKED_ROUNDS_REQUIRED - 1 },
    });
    const result = await report(
      { status: "blocked", summary: "No access.", blocker: "No access" },
      goal,
    );
    expect(result.result).toEqual({ recorded: true });
  });

  it("records other statuses without an instruction", async () => {
    const goal = testStoredGoal({ cycle, latestRunId: RUN_ID });
    const result = await report(
      { status: "continue", summary: "Did a thing.", nextAction: "Do the next." },
      goal,
    );
    expect(result.result).toEqual({ recorded: true });
  });
});
