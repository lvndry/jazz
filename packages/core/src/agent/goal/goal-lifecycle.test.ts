import { describe, expect, it } from "bun:test";
import type { RunState } from "@/core/agent/run/run-state";
import {
  decideAccept,
  decideCancel,
  decidePause,
  decideResume,
  type LatestRun,
} from "./goal-controls";
import { settleCycle, type CycleEnd } from "./goal-reconcile";
import { parseGoalRecord, type GoalRecord } from "./goal-record";
import { canTransitionGoal, type GoalState } from "./goal-state";
import { addSpend, extendBudget, reachedLimit, remainingCaps } from "./goal-usage";
import { testGoalPlan, testStoredGoal } from "./test-fixtures";

const RUN_ID = "run-1";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return testStoredGoal({
    plan: testGoalPlan({
      objective: "Importer handles CSV headers",
      successCriteria: ["Header test passes", "Docs mention headers"],
      steps: [
        { id: "fix", objective: "Fix parser", successCriteria: ["Test passes"], state: "pending" },
        {
          id: "docs",
          objective: "Update docs",
          successCriteria: ["Docs updated"],
          state: "pending",
        },
      ],
    }),
    budget: { maxCycles: 5, maxTokens: 10_000, maxDurationMs: 60_000, maxCostUSD: 1 },
    usage: {
      cycles: 1,
      totalTokens: 1_000,
      activeDurationMs: 1_000,
      costKnown: true,
      costUSD: 0.1,
    },
    cycle: { runId: RUN_ID, owner: { pid: 1, host: "host" } },
    latestRunId: RUN_ID,
    version: 3,
    ...overrides,
  });
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
      settleCycle(goal({ unverifiedClaims: 2 }), {
        run: { kind: "completed", spend: SPEND },
        evaluation: { kind: "invalid", reason: "no JSON" },
      }).state,
    ).toEqual({ kind: "review-required", reason: "no JSON" });
    const question = settleCycle(goal(), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({ status: "question", question: "Which delimiter?" }),
    });
    expect(question.state).toEqual({
      kind: "review-required",
      reason: "Jazz needs your input.",
      question: "Which delimiter?",
    });
    expect(question.lastProgress).toContain("Asked the user: Which delimiter?");
    expect(parseGoalRecord({ ...question, version: 4 }).ok).toBe(true);
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

describe("settleCycle outcomes are writable from every cycle state", () => {
  /**
   * The regression, from a live goal: a resumed run finished with verified evidence while
   * the goal was awaiting input, settleCycle produced "completed", and the store refused the
   * transition, leaving the goal stuck with its cycle open.
   */
  const states: { state: GoalState; stopAfter?: "pause" | "cancel" }[] = [
    { state: { kind: "active" } },
    { state: { kind: "awaiting-input", reason: "approval" } },
    { state: { kind: "paused" } },
    { state: { kind: "stopping" }, stopAfter: "pause" },
    { state: { kind: "stopping" }, stopAfter: "cancel" },
  ];
  const continued = valid({
    status: "continue",
    summary: "s",
    nextAction: "n",
    completedStepIds: ["fix"],
  });
  const ends: CycleEnd[] = [
    {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "complete",
        summary: "Done",
        evidence: [{ criterion: "Header test passes", quote: "1 pass 0 fail" }],
      }),
    },
    { run: { kind: "completed", spend: SPEND }, evaluation: continued },
    { run: { kind: "completed", spend: SPEND }, evaluation: continued, cappedBy: "tokens" },
    {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({ status: "blocked", summary: "b" }),
    },
    {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({ status: "question", question: "q" }),
    },
    { run: { kind: "completed", spend: SPEND }, evaluation: { kind: "invalid", reason: "bad" } },
    { run: { kind: "completed", spend: SPEND } },
    { run: { kind: "failed", error: "boom", spend: SPEND } },
    { run: { kind: "canceled", spend: SPEND } },
    { run: { kind: "missing" } },
  ];

  for (const { state, stopAfter } of states) {
    for (const end of ends) {
      const label = `${state.kind}${stopAfter ? `/${stopAfter}` : ""} + ${end.run.kind}${end.evaluation ? `/${end.evaluation.kind === "valid" ? end.evaluation.evaluation.status : "invalid"}` : ""}${end.cappedBy ? "/capped" : ""}`;
      it(label, () => {
        const from = goal({
          state,
          cycle: { ...goal().cycle!, ...(stopAfter !== undefined ? { stopAfter } : {}) },
        });
        const next = settleCycle(from, end);
        const legal =
          next.state.kind === from.state.kind ||
          canTransitionGoal(from.state.kind, next.state.kind);
        expect({ legal, to: next.state.kind }).toEqual({ legal: true, to: next.state.kind });
        const parsed = parseGoalRecord({ ...next, version: from.version + 1 });
        expect(parsed.ok ? "valid" : parsed.error).toBe("valid");
      });
    }
  }
});

describe("unverified completion claims", () => {
  const invalid = {
    kind: "invalid" as const,
    reason: "Completion evidence for criterion 2 does not appear in this cycle's tool output.",
  };

  /**
   * The regression: goals whose work was correct stopped for review because one completion
   * claim quoted output that was not there; a retry told what was missing usually recovers.
   */
  it("gives the next cycle the reason instead of stopping, up to the limit", () => {
    const first = settleCycle(goal(), {
      run: { kind: "completed", spend: SPEND },
      evaluation: invalid,
    });
    expect(first.state).toEqual({ kind: "active" });
    expect(first.unverifiedClaims).toBe(1);
    expect(first.lastProgress).toContain("criterion 2 does not appear");
    expect(parseGoalRecord({ ...first, version: 4 }).ok).toBe(true);

    const second = settleCycle(goal({ unverifiedClaims: 1 }), {
      run: { kind: "completed", spend: SPEND },
      evaluation: invalid,
    });
    expect(second.state).toEqual({ kind: "active" });
    expect(second.unverifiedClaims).toBe(2);

    const third = settleCycle(goal({ unverifiedClaims: 2 }), {
      run: { kind: "completed", spend: SPEND },
      evaluation: invalid,
    });
    expect(third.state.kind).toBe("review-required");
  });

  it("resets the count once a cycle reports verifiable progress", () => {
    const next = settleCycle(goal({ unverifiedClaims: 2 }), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "continue",
        summary: "s",
        nextAction: "n",
        completedStepIds: [],
      }),
    });
    expect(next.unverifiedClaims).toBeUndefined();
  });
});

describe("cycles cut off by the process stopping", () => {
  const interrupted: CycleEnd = { run: { kind: "interrupted", spend: SPEND } };

  it("continues with a fresh cycle told to check the state, up to the limit", () => {
    const first = settleCycle(goal(), interrupted);
    expect(first.state).toEqual({ kind: "active" });
    expect(first.interruptedCycles).toBe(1);
    expect(first.lastProgress).toContain("Check the current state before redoing anything");
    expect(first.usage.totalTokens).toBe(1_500);
    expect(parseGoalRecord({ ...first, version: 4 }).ok).toBe(true);

    expect(settleCycle(goal({ interruptedCycles: 1 }), interrupted).interruptedCycles).toBe(2);
    expect(settleCycle(goal({ interruptedCycles: 2 }), interrupted).state.kind).toBe(
      "review-required",
    );
  });

  it("honors a pause or cancel requested before the process stopped", () => {
    const stopping = (stopAfter: "pause" | "cancel") =>
      goal({
        state: { kind: "stopping" },
        cycle: { runId: RUN_ID, owner: { pid: 1, host: "host" }, stopAfter },
      });
    expect(settleCycle(stopping("pause"), interrupted).state).toEqual({ kind: "paused" });
    expect(settleCycle(stopping("cancel"), interrupted).state).toEqual({ kind: "canceled" });
  });

  it("resets the count once a cycle reports verifiable progress", () => {
    const next = settleCycle(goal({ interruptedCycles: 2 }), {
      run: { kind: "completed", spend: SPEND },
      evaluation: valid({
        status: "continue",
        summary: "s",
        nextAction: "n",
        completedStepIds: [],
      }),
    });
    expect(next.interruptedCycles).toBeUndefined();
  });
});

describe("the authority granted on acceptance", () => {
  const proposed = (): GoalRecord => {
    const {
      cycle: _cycle,
      latestRunId: _latestRunId,
      approvedPlanRevision: _approved,
      ...unaccepted
    } = goal({
      state: { kind: "proposed" },
      usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: true, costUSD: 0 },
    });
    return unaccepted;
  };

  it("records the policy the user grants with the acceptance", () => {
    const decision = decideAccept(proposed(), 1, "high-risk");
    expect(decision.kind === "write" && decision.next.approvalPolicy).toBe("high-risk");
  });

  it("grants nothing extra when accepted without one", () => {
    const decision = decideAccept(proposed(), 1);
    expect(decision.kind === "write" && "approvalPolicy" in decision.next).toBe(false);
  });

  it("refuses a record where a proposal carries authority before anyone accepted it", () => {
    expect(parseGoalRecord({ ...proposed(), approvalPolicy: "high-risk" }).ok).toBe(false);
    expect(parseGoalRecord({ ...goal(), approvalPolicy: "high-risk" }).ok).toBe(true);
  });
});

describe("counters that must run in a row", () => {
  /** The regression: a cycle with an unverified claim kept the interruption count alive. */
  it("an interruption streak ends at any cycle that finishes, verified or not", () => {
    const next = settleCycle(goal({ interruptedCycles: 2 }), {
      run: { kind: "completed", spend: SPEND },
      evaluation: {
        kind: "invalid",
        reason: "Completion evidence for criterion 1 does not appear in this cycle's tool output.",
      },
    });
    expect(next.interruptedCycles).toBeUndefined();
    expect(next.unverifiedClaims).toBe(1);
  });
});

describe("resuming a goal that ran out of budget while paused", () => {
  /** The regression: it went straight back to budget-limited on the next tick. */
  it("extends the budget so the resumed goal can run", () => {
    const { cycle: _cycle, ...paused } = goal({
      state: { kind: "paused" },
      usage: {
        cycles: 5,
        totalTokens: 1_000,
        activeDurationMs: 1_000,
        costKnown: true,
        costUSD: 0.1,
      },
    });
    const decision = decideResume(paused, undefined);
    expect(decision.kind).toBe("write");
    if (decision.kind === "write") {
      expect(decision.next.state).toEqual({ kind: "active" });
      expect(decision.next.budget.maxCycles).toBeGreaterThan(5);
      expect(reachedLimit(decision.next)).toBeUndefined();
    }
  });
});

describe("resuming a paused goal whose parked run used up the budget", () => {
  /**
   * The regression: the extension measured from recorded usage, which excludes the parked
   * run's spend, so a 5M-token goal whose parked run had spent 5M was "extended" to 5M.
   */
  it("extends past what the parked run has spent, so the answer can go through", () => {
    const paused = goal({
      state: { kind: "paused" },
      budget: { maxCycles: 5, maxTokens: 5_000_000, maxDurationMs: 60_000_000 },
      usage: { cycles: 1, totalTokens: 0, activeDurationMs: 0, costKnown: true, costUSD: 0 },
    });
    const parked: LatestRun = {
      state: {
        kind: "input-required",
        pending: { kind: "question", toolCallId: "call-1", question: "Which folder?" },
      } as never,
      spend: { totalTokens: 5_000_000, activeDurationMs: 1_000 },
    };
    const decision = decideResume(paused, parked);
    expect(decision.kind).toBe("write");
    if (decision.kind === "write") {
      expect(remainingCaps(decision.next, parked.spend).kind).toBe("caps");
    }
  });
});
