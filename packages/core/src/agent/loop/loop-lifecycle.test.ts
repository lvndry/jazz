import { describe, expect, it } from "bun:test";
import {
  claimLoopRun,
  decideLoopControl,
  isLoopDue,
  loopRunCaps,
  nextRunAfter,
  settleLoopRun,
} from "./loop-lifecycle";
import { parseLoopRecord, type LoopRecord } from "./loop-record";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const OWNER = { pid: 4242, host: "box", startedAt: 1 };
const SPEND = { totalTokens: 1_000, costUSD: 0.01, activeDurationMs: 2_000 };

function loop(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    loopId: "loop-1",
    ownerInstanceId: "owner",
    agentId: "agent-1",
    conversationId: "loop-chat",
    workingDirectory: "/work/site",
    prompt: "Check whether the deploy finished and report.",
    schedule: { kind: "every", everyMs: 10 * 60_000 },
    budget: {
      maxTokens: 100_000,
      maxDurationMs: 3_600_000,
      maxCostUSD: 1,
      maxIterationsPerRun: 12,
    },
    usage: { runs: 0, totalTokens: 0, costKnown: true, costUSD: 0, activeDurationMs: 0 },
    state: { kind: "active" },
    nextRunAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...overrides,
  };
}

function running(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return { ...loop(overrides), ...claimLoopRun(loop(overrides), "run-1", OWNER, NOW), version: 2 };
}

describe("when a loop runs", () => {
  it("is due once its time comes, never while a run is in flight or it is paused", () => {
    expect(isLoopDue(loop(), NOW)).toBe(true);
    expect(isLoopDue(loop({ nextRunAt: "2026-09-26T10:05:00.000Z" }), NOW)).toBe(false);
    expect(isLoopDue(running(), NOW)).toBe(false);
    expect(isLoopDue(loop({ state: { kind: "paused" } }), NOW)).toBe(false);
  });

  it("schedules the next run from now, so missed runs collapse into one", () => {
    expect(nextRunAfter({ kind: "every", everyMs: 600_000 }, NOW)?.toISOString()).toBe(
      "2026-09-26T10:10:00.000Z",
    );
    expect(
      nextRunAfter(
        { kind: "cron", expression: "0 9 * * mon", timezone: "Europe/Paris" },
        NOW,
      )?.toISOString(),
    ).toBe("2026-09-28T07:00:00.000Z");
  });

  it("gives a run only what the loop has left", () => {
    expect(
      loopRunCaps(
        loop({
          usage: {
            runs: 3,
            totalTokens: 90_000,
            costKnown: true,
            costUSD: 0.4,
            activeDurationMs: 0,
          },
        }),
      ),
    ).toEqual({ maxTokens: 10_000, maxDurationMs: 3_600_000, maxCostUSD: 0.6 });
  });
});

describe("settling a run", () => {
  it("folds in its spend, records the outcome, and waits for the next run", () => {
    const next = settleLoopRun(
      running(),
      { outcome: "completed", spend: SPEND, text: "Still deploying." },
      NOW,
    );
    expect(next.state).toEqual({ kind: "active" });
    expect(next.run).toBeUndefined();
    expect(next.usage).toMatchObject({ runs: 1, totalTokens: 1_000, costUSD: 0.01 });
    expect(next.lastRun).toMatchObject({
      runId: "run-1",
      outcome: "completed",
      summary: "Still deploying.",
    });
    expect(next.nextRunAt).toBe("2026-09-26T10:10:00.000Z");
    expect(parseLoopRecord({ ...next, version: 3 }).ok).toBe(true);
  });

  it("ends when its run asked to, with the reason", () => {
    const next = settleLoopRun(
      running(),
      { outcome: "completed", spend: SPEND, endRequested: "The deploy finished." },
      NOW,
    );
    expect(next.state).toEqual({ kind: "completed", reason: "The deploy finished." });
  });

  it("applies a cancel or pause asked for while the run was in flight", () => {
    const cancel = decideLoopControl(running(), "cancel", NOW);
    const pause = decideLoopControl(running(), "pause", NOW);
    if (cancel.kind !== "write" || pause.kind !== "write") {
      throw new Error("expected writes");
    }
    const asRecord = (input: typeof cancel.next): LoopRecord => ({ ...input, version: 3 });
    expect(settleLoopRun(asRecord(cancel.next), { outcome: "completed" }, NOW).state).toEqual({
      kind: "canceled",
    });
    expect(settleLoopRun(asRecord(pause.next), { outcome: "completed" }, NOW).state).toEqual({
      kind: "paused",
    });
  });

  it("stops after too many failures in a row, and a finished run clears the streak", () => {
    const failing = running({ consecutiveFailures: 2 });
    const stopped = settleLoopRun(failing, { outcome: "failed", text: "Tool not found" }, NOW);
    expect(stopped.state.kind).toBe("failed");
    expect(stopped.consecutiveFailures).toBe(3);

    const recovered = settleLoopRun(
      running({ consecutiveFailures: 2 }),
      { outcome: "completed" },
      NOW,
    );
    expect(recovered.consecutiveFailures).toBeUndefined();
  });

  it("completes at its run limit and stops at a spent budget", () => {
    const limited = running({
      budget: { maxRuns: 1, maxTokens: 100_000, maxDurationMs: 3_600_000, maxIterationsPerRun: 12 },
    });
    expect(settleLoopRun(limited, { outcome: "completed" }, NOW).state.kind).toBe("completed");

    const spent = settleLoopRun(
      running(),
      { outcome: "completed", spend: { ...SPEND, totalTokens: 100_000 } },
      NOW,
    );
    expect(spent.state).toEqual({ kind: "budget-limited", limit: "tokens" });
  });

  it("completes once its end time has passed", () => {
    const expiring = running({
      budget: {
        maxTokens: 100_000,
        maxDurationMs: 3_600_000,
        maxIterationsPerRun: 12,
        expiresAt: "2026-09-26T09:00:00.000Z",
      },
    });
    expect(settleLoopRun(expiring, { outcome: "completed" }, NOW).state.kind).toBe("completed");
  });
});

describe("the user's controls", () => {
  it("resumes a stopped loop at once if it is overdue, clearing its failure streak", () => {
    const decision = decideLoopControl(
      loop({
        state: { kind: "failed", reason: "x" },
        consecutiveFailures: 3,
        nextRunAt: "2026-09-26T09:00:00.000Z",
      }),
      "resume",
      NOW,
    );
    expect(decision.kind).toBe("write");
    if (decision.kind === "write") {
      expect(decision.next.state).toEqual({ kind: "active" });
      expect(decision.next.consecutiveFailures).toBeUndefined();
      expect(decision.next.nextRunAt).toBe(NOW.toISOString());
    }
  });

  it("extends a spent budget on resume so the loop can run", () => {
    const decision = decideLoopControl(
      loop({
        state: { kind: "budget-limited", limit: "tokens" },
        usage: {
          runs: 9,
          totalTokens: 100_000,
          costKnown: true,
          costUSD: 0.5,
          activeDurationMs: 0,
        },
      }),
      "resume",
      NOW,
    );
    expect(decision.kind === "write" && decision.next.budget.maxTokens).toBeGreaterThan(100_000);
  });

  it("refuses to change an ended loop", () => {
    expect(decideLoopControl(loop({ state: { kind: "canceled" } }), "resume", NOW).kind).toBe(
      "refused",
    );
    expect(
      decideLoopControl(loop({ state: { kind: "completed", reason: "done" } }), "pause", NOW).kind,
    ).toBe("refused");
  });
});
