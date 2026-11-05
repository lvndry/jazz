import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  BLOCKED_ROUNDS_REQUIRED,
  MAX_CONSECUTIVE_BLOCKED_REPORTS,
} from "@/core/agent/goal/goal-blocker";
import type { GoalRecord } from "@/core/agent/goal/goal-record";
import { testStoredGoal } from "@/core/agent/goal/test-fixtures";
import { GoalStoreTag, type GoalStore } from "@/core/interfaces/goal-store";
import { partialFake } from "@/core/test-support/fakes";
import { createReportGoalCycleTool } from "./goal-report";

const RUN_ID = "run-1";

function storeHolding(goal: GoalRecord): GoalStore {
  return partialFake<GoalStore>({ list: () => Effect.succeed([goal]) });
}

function report(
  args: Record<string, unknown>,
  goal: GoalRecord,
  context: { agentId: string; runId?: string } = { agentId: "agent-1", runId: RUN_ID },
) {
  return Effect.runPromise(
    createReportGoalCycleTool()
      .execute(args as never, context)
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
      blockerStreak: { blocker: "access no", rounds: BLOCKED_ROUNDS_REQUIRED - 1 },
    });
    const result = await report(
      { status: "blocked", summary: "No access.", blocker: "No access" },
      goal,
    );
    expect(result.result).toEqual({ recorded: true });
  });

  it("rejects a blocked report that names no blocker", async () => {
    const goal = testStoredGoal({ cycle, latestRunId: RUN_ID });
    const result = await report({ status: "blocked", summary: "No access." }, goal);
    expect(result.success).toBe(false);
  });

  it("gives no instruction once enough blocked reports have run in a row, whatever they named", async () => {
    const goal = testStoredGoal({
      cycle,
      latestRunId: RUN_ID,
      blockerStreak: {
        blocker: "other thing",
        rounds: 1,
        reports: MAX_CONSECUTIVE_BLOCKED_REPORTS - 1,
      },
    });
    const result = await report(
      { status: "blocked", summary: "No access.", blocker: "No access" },
      goal,
    );
    expect(result.result).toEqual({ recorded: true });
  });

  it("does not match a goal that has no open cycle when the call has no run id", async () => {
    const goal = testStoredGoal({ blockerStreak: { blocker: "access no", rounds: 1 } });
    const result = await report(
      { status: "blocked", summary: "No access.", blocker: "No access" },
      goal,
      { agentId: "agent-1" },
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
