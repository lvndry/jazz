import { describe, expect, it } from "bun:test";
import type { RunState } from "@/core/agent/run/run-state";
import { decideCancel, decidePause, decideResume, type LatestRun } from "./goal-controls";
import { settleCycle } from "./goal-reconcile";
import { parseGoalRecord, type GoalRecord } from "./goal-record";
import { addSpend, extendBudget, reachedLimit, remainingCaps } from "./goal-usage";

const RUN_ID = "run-1";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    goalId: "goal-1",
    ownerInstanceId: "owner",
    agentId: "agent",
    conversationId: "goal-chat",
    request: "Make the importer handle CSV headers",
    plan: {
      revision: 1,
      objective: "Importer handles CSV headers",
      successCriteria: ["Header test passes", "Docs mention headers"],
      constraints: [],
      assumptions: [],
      feasibility: { assessment: "plausible", rationale: "Small change." },
      steps: [
        { id: "fix", objective: "Fix parser", successCriteria: ["Test passes"], state: "pending" },
        {
          id: "docs",
          objective: "Update docs",
          successCriteria: ["Docs updated"],
          state: "pending",
        },
      ],
      verification: ["bun test"],
    },
    approvedPlanRevision: 1,
    state: { kind: "active" },
    budget: { maxCycles: 5, maxTokens: 10_000, maxDurationMs: 60_000, maxCostUSD: 1 },
    usage: {
      cycles: 1,
      totalTokens: 1_000,
      activeDurationMs: 1_000,
      costKnown: true,
      costUSD: 0.1,
    },
    cycle: { runId: RUN_ID, owner: { pid: 1, host: "host" }, historyStart: 4 },
    latestRunId: RUN_ID,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

const SPEND = { totalTokens: 500, costUSD: 0.05, activeDurationMs: 2_000 };

function valid(evaluation: object) {
  return { kind: "valid" as const, evaluation: evaluation as never };
}

describe("goal record schema", () => {
  it("accepts a well-formed record", () => {
    expect(parseGoalRecord(goal()).ok).toBe(true);
  });

  it("rejects states that contradict the open cycle", () => {
    const { cycle: _cycle, ...withoutCycle } = goal({
      state: { kind: "awaiting-input", reason: "approval" },
    });
    expect(parseGoalRecord({ ...withoutCycle, version: 3 }).ok).toBe(false);
    expect(parseGoalRecord(goal({ state: { kind: "completed", summary: "done" } })).ok).toBe(false);
    expect(parseGoalRecord(goal({ state: { kind: "stopping" } })).ok).toBe(false);
  });

  it("rejects cost marked known without a cost, and unapproved active plans", () => {
    expect(
      parseGoalRecord(
        goal({ usage: { cycles: 1, totalTokens: 1, activeDurationMs: 1, costKnown: true } }),
      ).ok,
    ).toBe(false);
    const { approvedPlanRevision: _approved, ...unapproved } = goal();
    expect(parseGoalRecord(unapproved).ok).toBe(false);
  });
});

describe("goal usage", () => {
  it("adds spend and keeps cost unknown once any run lacked pricing", () => {
    const unpriced = addSpend(goal().usage, { totalTokens: 10, activeDurationMs: 1 });
    expect(unpriced).toEqual({
      cycles: 1,
      totalTokens: 1_010,
      activeDurationMs: 1_001,
      costKnown: false,
    });
    expect(addSpend(unpriced, SPEND).costKnown).toBe(false);
  });

  it("reports the first cap reached and what a resumed run may still spend", () => {
    expect(reachedLimit(goal())).toBeUndefined();
    expect(reachedLimit(goal({ usage: { ...goal().usage, cycles: 5 } }))).toBe("cycles");
    expect(remainingCaps(goal(), SPEND)).toEqual({
      kind: "caps",
      caps: { maxTokens: 8_500, maxDurationMs: 57_000, maxCostUSD: 0.85 },
    });
    expect(remainingCaps(goal(), { ...SPEND, totalTokens: 9_000 })).toEqual({
      kind: "limit",
      limit: "tokens",
    });
  });

  it("extends a budget to one default budget of room past current usage", () => {
    const extended = extendBudget(goal({ usage: { ...goal().usage, cycles: 5 } }));
    expect(extended.maxCycles).toBeGreaterThan(5);
    expect(extended.maxTokens).toBeGreaterThan(goal().usage.totalTokens);
  });
});

describe("settleCycle", () => {
  it("completes on verified evidence, folds spend in once, and closes the cycle", () => {
    const next = settleCycle(goal(), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "complete",
        summary: "Done",
        evidence: [{ criterion: "Header test passes", quote: "1 pass" }],
      }),
    });
    expect(next.state).toEqual({ kind: "completed", summary: "Done" });
    expect(next.cycle).toBeUndefined();
    expect(next.usage.totalTokens).toBe(1_500);
    expect(next.evidence?.runId).toBe(RUN_ID);
    expect(parseGoalRecord({ ...next, version: 4 }).ok).toBe(true);
  });

  it("marks finished steps and stays active on continue", () => {
    const next = settleCycle(goal(), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "continue",
        summary: "Fixed",
        nextAction: "Docs",
        completedStepIds: ["fix"],
      }),
    });
    expect(next.state).toEqual({ kind: "active" });
    expect(next.plan.steps.map((step) => step.state)).toEqual(["completed", "pending"]);
    expect(next.lastProgress).toBe("Fixed\nNext: Docs");
  });

  it("applies a pause requested mid-cycle after recording its progress", () => {
    const pausing = goal({
      state: { kind: "stopping" },
      cycle: { ...goal().cycle!, stopAfter: "pause" },
    });
    const next = settleCycle(pausing, {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "continue",
        summary: "Fixed",
        nextAction: "Docs",
        completedStepIds: ["fix"],
      }),
    });
    expect(next.state).toEqual({ kind: "paused" });
    expect(next.plan.steps[0]?.state).toBe("completed");
  });

  it("prefers a verified completion over a requested stop", () => {
    const canceling = goal({
      state: { kind: "stopping" },
      cycle: { ...goal().cycle!, stopAfter: "cancel" },
    });
    const next = settleCycle(canceling, {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({ status: "complete", summary: "Done", evidence: [] }),
    });
    expect(next.state.kind).toBe("completed");
  });

  it("sends failed, missing, invalid, blocked, and question outcomes to review", () => {
    const failed = settleCycle(goal(), { run: { kind: "failed", error: "timeout", spend: SPEND } });
    expect(failed.state.kind).toBe("review-required");
    expect(failed.usage.totalTokens).toBe(1_500);
    expect(settleCycle(goal(), { run: { kind: "missing" } }).usage).toEqual(goal().usage);
    expect(
      settleCycle(goal(), {
        run: { kind: "completed", spend: SPEND },
        evaluation: { kind: "invalid", reason: "no JSON" },
      }).state,
    ).toEqual({ kind: "review-required", reason: "no JSON" });
    const question = settleCycle(goal(), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({ status: "question", question: "Which delimiter?" }),
    });
    expect(question.state.kind === "review-required" && question.state.reason).toContain(
      "/goal resume goal-1",
    );
  });

  it("stops at a budget cap the cycle hit or the goal reached", () => {
    const continued = valid({
      status: "continue",
      summary: "s",
      nextAction: "n",
      completedStepIds: [],
    });
    expect(
      settleCycle(goal(), {
        run: { kind: "completed", spend: SPEND },
        evaluation: continued,
        cappedBy: "tokens",
      }).state,
    ).toEqual({ kind: "budget-limited", limit: "tokens" });
    expect(
      settleCycle(goal({ usage: { ...goal().usage, cycles: 5 } }), {
        run: { kind: "completed", spend: SPEND },
        evaluation: continued,
      }).state,
    ).toEqual({ kind: "budget-limited", limit: "cycles" });
  });
});

function latest(state: RunState): LatestRun {
  return { state, spend: SPEND };
}

const PARKED: RunState = {
  kind: "input-required",
  pending: { kind: "question", toolCallId: "call", question: "Which file?" } as never,
  snapshot: {} as never,
  expiresAt: "2026-09-27T00:00:00.000Z",
};

describe("goal controls", () => {
  it("fences a running cycle on pause and pauses an idle goal directly", () => {
    const running = decidePause(goal());
    expect(running.kind === "write" && running.next.state).toEqual({ kind: "stopping" });
    expect(running.kind === "write" && running.next.cycle?.stopAfter).toBe("pause");
    const { cycle: _cycle, ...idle } = goal();
    const paused = decidePause(idle as GoalRecord);
    expect(paused.kind === "write" && paused.next.state).toEqual({ kind: "paused" });
  });

  /**
   * The regression: a paused goal whose parked run was abandoned or failed was resumed as
   * active without reconciling that run, and the cycle's spend vanished from the goal.
   */
  it("reconciles a paused cycle whose run ended while paused instead of dropping its spend", () => {
    const pausedParked = goal({ state: { kind: "paused" } });
    const decision = decideResume(
      pausedParked,
      latest({ kind: "failed", cause: "error", error: "abandoned" } as RunState),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind === "write") {
      expect(decision.next.state.kind).toBe("review-required");
      expect(decision.next.cycle).toBeUndefined();
      expect(decision.next.usage.totalTokens).toBe(1_500);
    }
  });

  it("returns a paused goal with a still-parked run to awaiting input", () => {
    const decision = decideResume(goal({ state: { kind: "paused" } }), latest(PARKED));
    expect(decision.kind === "write" && decision.next.state).toEqual({
      kind: "awaiting-input",
      reason: "question",
    });
  });

  it("carries the user's answer into the next cycle's progress on resume", () => {
    const { cycle: _cycle, ...rest } = goal({
      state: { kind: "review-required", reason: "Which delimiter?" },
    });
    const decision = decideResume(rest as GoalRecord, undefined, "Use semicolons");
    expect(decision.kind === "write" && decision.next.lastProgress).toContain(
      "User guidance: Use semicolons",
    );
    expect(decision.kind === "write" && decision.next.state).toEqual({ kind: "active" });
  });

  it("extends the budget when resuming a budget-limited goal", () => {
    const { cycle: _cycle, ...rest } = goal({
      state: { kind: "budget-limited", limit: "cycles" },
      usage: { ...goal().usage, cycles: 5 },
    });
    const decision = decideResume(rest as GoalRecord, undefined);
    expect(decision.kind === "write" && decision.next.budget.maxCycles).toBeGreaterThan(5);
  });

  it("records a cancel on an open cycle and cancels an idle goal outright", () => {
    const withCycle = decideCancel(goal({ state: { kind: "awaiting-input", reason: "approval" } }));
    expect(withCycle.kind === "write" && withCycle.next.cycle?.stopAfter).toBe("cancel");
    const { cycle: _cycle, ...idle } = goal({ state: { kind: "review-required", reason: "x" } });
    const canceled = decideCancel(idle as GoalRecord);
    expect(canceled.kind === "write" && canceled.next.state).toEqual({ kind: "canceled" });
    expect(
      decideCancel(goal({ state: { kind: "completed", summary: "d" }, cycle: undefined as never }))
        .kind,
    ).toBe("refused");
  });
});
