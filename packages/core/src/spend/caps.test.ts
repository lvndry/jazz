import { describe, expect, it } from "bun:test";
import type { DaemonConfig } from "@/core/types/config";
import {
  capStatuses,
  describeCapCheck,
  evaluateSpendCaps,
  reachedMachineDailyCap,
  unattendedSpend,
} from "./caps";
import { addEntryToDay, EMPTY_DAY, type DaySpend } from "./ledger";
import type { SpendSource } from "./sources";

function day(
  runs: ReadonlyArray<{
    agentId?: string;
    source?: SpendSource;
    costUSD?: number;
    tokens?: number;
    costKnown?: boolean;
    unattended?: boolean;
  }>,
): DaySpend {
  return runs.reduce(
    (spend, run) =>
      addEntryToDay(spend, {
        at: new Date().toISOString(),
        agentId: run.agentId ?? "a",
        source: run.source ?? "workflow",
        costUSD: run.costUSD ?? 0,
        costKnown: run.costKnown ?? true,
        tokens: run.tokens ?? 1,
        unattended: run.unattended ?? true,
      }),
    EMPTY_DAY,
  );
}

function windows(today: DaySpend, month: DaySpend = today) {
  return { today, month };
}

const run = { agentId: "a", source: "workflow" } as const;

describe("evaluateSpendCaps", () => {
  it("is clear with no caps, however much was spent", () => {
    expect(evaluateSpendCaps(undefined, windows(day([{ costUSD: 1_000 }])), run).kind).toBe(
      "clear",
    );
  });

  it("reaches the machine daily cap on unattended spend, never on a chat's", () => {
    const caps: DaemonConfig = { dailyCostUSD: 5 };

    expect(
      evaluateSpendCaps(caps, windows(day([{ costUSD: 9, unattended: false }])), run).kind,
    ).toBe("clear");
    expect(
      evaluateSpendCaps(caps, windows(day([{ costUSD: 3 }, { costUSD: 2 }])), run),
    ).toMatchObject({ kind: "reached", period: "day", measure: "cost", limit: 5, spent: 5 });
  });

  it("reaches the daily token cap without pricing", () => {
    const today = day([
      { tokens: 600, costKnown: false },
      { tokens: 500, costKnown: false },
    ]);

    expect(evaluateSpendCaps({ dailyTokens: 1_000 }, windows(today), run)).toMatchObject({
      kind: "reached",
      measure: "tokens",
      spent: 1_100,
    });
  });

  it("does not enforce a dollar cap while a counted run is unpriced", () => {
    const today = day([{ costUSD: 9 }, { costKnown: false }]);

    expect(evaluateSpendCaps({ dailyCostUSD: 1 }, windows(today), run).kind).toBe("clear");
    expect(capStatuses({ dailyCostUSD: 1 }, windows(today))[0]).toMatchObject({
      reached: false,
      unpricedRuns: 1,
    });
  });

  it("applies the goals caps to goal and loop runs only", () => {
    const today = day([
      { source: "goal", costUSD: 4 },
      { source: "loop", costUSD: 1 },
    ]);
    const caps: DaemonConfig = { goals: { dailyCostUSD: 5 } };

    expect(evaluateSpendCaps(caps, windows(today), { agentId: "a", source: "loop" }).kind).toBe(
      "reached",
    );
    expect(evaluateSpendCaps(caps, windows(today), run).kind).toBe("clear");
  });

  it("counts only the agent's own unattended runs against its cap", () => {
    const today = day([
      { agentId: "other", costUSD: 10 },
      { agentId: "mine", costUSD: 1 },
      { agentId: "mine", costUSD: 5, unattended: false },
    ]);
    const caps: DaemonConfig = { agents: { mine: { dailyCostUSD: 2 } } };

    expect(evaluateSpendCaps(caps, windows(today), { agentId: "mine", source: "run" }).kind).toBe(
      "clear",
    );
  });

  it("checks a monthly cap against the month", () => {
    const month = day([{ costUSD: 19 }, { costUSD: 1 }]);

    expect(evaluateSpendCaps({ monthlyCostUSD: 20 }, windows(day([]), month), run)).toMatchObject({
      kind: "reached",
      period: "month",
      spent: 20,
    });
  });

  it("skips the machine caps once they are lifted for today, keeping the others", () => {
    const today = day([{ source: "goal", costUSD: 9 }]);
    const caps: DaemonConfig = { dailyCostUSD: 1, goals: { dailyCostUSD: 5 } };
    const goal = { agentId: "a", source: "goal" } as const;

    expect(evaluateSpendCaps(caps, windows(today), goal, { machineCapLifted: true })).toMatchObject(
      { kind: "reached", scope: { kind: "goals" } },
    );
    expect(
      evaluateSpendCaps({ dailyCostUSD: 1 }, windows(today), run, { machineCapLifted: true }).kind,
    ).toBe("clear");
  });

  it("names the key to change in its refusal", () => {
    const check = evaluateSpendCaps(
      { agents: { inbox: { monthlyCostUSD: 3 } } },
      windows(day([{ agentId: "inbox", costUSD: 3 }])),
      { agentId: "inbox", source: "run" },
    );
    if (check.kind === "clear") {
      throw new Error("expected a reached cap");
    }

    expect(describeCapCheck(check)).toContain("daemon.agents.inbox.monthlyCostUSD");
  });
});

describe("the daemon's daily pause reads the ledger", () => {
  it("reports the machine daily cap reached, by measure", () => {
    const today = day([{ costUSD: 2, tokens: 10_000 }]);

    expect(reachedMachineDailyCap({ dailyCostUSD: 2 }, windows(today))).toBe("cost");
    expect(reachedMachineDailyCap({ dailyCostUSD: 3 }, windows(today))).toBeUndefined();
    expect(reachedMachineDailyCap({ dailyTokens: 10_000 }, windows(today))).toBe("tokens");
    expect(reachedMachineDailyCap({ monthlyCostUSD: 1 }, windows(today))).toBeUndefined();
  });

  it("sums unattended spend, and stops knowing its cost once a counted run is unpriced", () => {
    expect(unattendedSpend(day([{ costUSD: 0.5 }, { costUSD: 0.25, unattended: false }]))).toEqual({
      runs: 1,
      totalTokens: 1,
      costUSD: 0.5,
      costKnown: true,
    });
    expect(unattendedSpend(day([{ costKnown: false }]))).toEqual({
      runs: 1,
      totalTokens: 1,
      costKnown: false,
    });
  });
});
