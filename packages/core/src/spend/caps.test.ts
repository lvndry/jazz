import { describe, expect, it } from "bun:test";
import type { DaemonConfig } from "@/core/types/config";
import {
  blockingMachineDailyCap,
  capStatuses,
  describeCapCheck,
  estimatedRunSpend,
  evaluateSpendCaps,
  unattendedSpend,
  unknownAgentCapKeys,
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

  it("blocks a daily dollar cap as unverifiable while a counted run today is unpriced", () => {
    const today = day([{ costUSD: 0.5 }, { costKnown: false }]);

    expect(evaluateSpendCaps({ dailyCostUSD: 1 }, windows(today), run)).toMatchObject({
      kind: "unverifiable",
      period: "day",
      unpricedRuns: 1,
      spent: 0.5,
    });
    expect(capStatuses({ dailyCostUSD: 1 }, windows(today))[0]).toMatchObject({
      reached: false,
      unverifiable: true,
      unpricedRuns: 1,
    });
  });

  it("reaches a dollar cap on priced spend alone, whatever runs went unpriced", () => {
    const today = day([{ costUSD: 9 }, { costKnown: false }]);

    expect(evaluateSpendCaps({ dailyCostUSD: 1 }, windows(today), run)).toMatchObject({
      kind: "reached",
      spent: 9,
    });
    expect(evaluateSpendCaps({ monthlyCostUSD: 5 }, windows(day([]), today), run)).toMatchObject({
      kind: "reached",
      period: "month",
    });
  });

  it("counts priced spend against a monthly cap and lets unpriced runs through under it", () => {
    const month = day([{ costUSD: 2 }, { costKnown: false }]);

    expect(evaluateSpendCaps({ monthlyCostUSD: 5 }, windows(day([]), month), run).kind).toBe(
      "clear",
    );
    expect(capStatuses({ monthlyCostUSD: 5 }, windows(day([]), month))[0]).toMatchObject({
      reached: false,
      unverifiable: false,
      unpricedRuns: 1,
    });
  });

  it("reports a reached cap before an unverifiable one", () => {
    const today = day([{ source: "goal", costUSD: 6 }, { costKnown: false }]);
    const caps: DaemonConfig = { dailyCostUSD: 100, goals: { dailyCostUSD: 5 } };

    expect(evaluateSpendCaps(caps, windows(today), { agentId: "a", source: "goal" })).toMatchObject(
      { kind: "reached", scope: { kind: "goals" } },
    );
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

  it("skips the machine daily caps once they are lifted for today, keeping the others", () => {
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

  it("keeps the machine monthly cap in force when the daily caps are lifted", () => {
    const today = day([{ costUSD: 9 }]);
    const caps: DaemonConfig = { dailyCostUSD: 1, monthlyCostUSD: 5 };

    expect(evaluateSpendCaps(caps, windows(today), run, { machineCapLifted: true })).toMatchObject({
      kind: "reached",
      scope: { kind: "machine" },
      period: "month",
    });
  });

  it("matches an agent cap keyed by the agent's name as well as its id", () => {
    const today = day([{ agentId: "k3x9", costUSD: 2 }]);
    const caps: DaemonConfig = { agents: { inbox: { dailyCostUSD: 1 } } };

    expect(
      evaluateSpendCaps(caps, windows(today), {
        agentId: "k3x9",
        agentName: "inbox",
        source: "run",
      }),
    ).toMatchObject({ kind: "reached", scope: { kind: "agent", key: "inbox", agentId: "k3x9" } });
    expect(
      evaluateSpendCaps(caps, windows(today), {
        agentId: "k3x9",
        agentName: "other",
        source: "run",
      }).kind,
    ).toBe("clear");
  });

  it("resolves an agent cap's name to its id for the status, and names keys that match no agent", () => {
    const today = day([{ agentId: "k3x9", costUSD: 2 }]);
    const caps: DaemonConfig = {
      agents: {
        inbox: { dailyCostUSD: 1 },
        k3x9: { monthlyCostUSD: 9 },
        typo: { dailyCostUSD: 1 },
      },
    };
    const agents = [{ id: "k3x9", name: "inbox" }];

    expect(capStatuses(caps, windows(today), { agents })).toMatchObject([
      { key: "daemon.agents.inbox.dailyCostUSD", spent: 2, reached: true },
      { key: "daemon.agents.k3x9.monthlyCostUSD", spent: 2, reached: false },
      { key: "daemon.agents.typo.dailyCostUSD", spent: 0, reached: false },
    ]);
    expect(unknownAgentCapKeys(caps, agents)).toEqual(["typo"]);
  });

  it("marks only the machine daily caps lifted in the status", () => {
    const today = day([{ costUSD: 9 }]);
    const liftedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const statuses = capStatuses({ dailyCostUSD: 1, monthlyCostUSD: 5 }, windows(today), {
      machineCapLiftedUntil: liftedUntil,
    });

    expect(statuses.map((status) => [status.period, status.liftedUntil])).toEqual([
      ["day", liftedUntil],
      ["month", undefined],
    ]);
  });

  it("estimates a run at the average of this month's unattended runs", () => {
    const month = day([
      { costUSD: 1, tokens: 100 },
      { costUSD: 3, tokens: 300 },
      { costKnown: false, tokens: 200 },
      { costUSD: 50, unattended: false },
    ]);

    expect(estimatedRunSpend(month)).toEqual({ costUSD: 2, tokens: 200 });
    expect(estimatedRunSpend(EMPTY_DAY)).toEqual({ costUSD: 0, tokens: 0 });
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
    expect(describeCapCheck(check)).not.toContain("jazz daemon resume");
  });

  it("says an unverifiable daily cap cannot be verified, and how to lift it", () => {
    const check = evaluateSpendCaps(
      { dailyCostUSD: 5 },
      windows(day([{ costKnown: false }, { costKnown: false }])),
      run,
    );
    if (check.kind === "clear") {
      throw new Error("expected a blocking cap");
    }

    const message = describeCapCheck(check);
    expect(message).toContain("cannot be verified: 2 unattended runs today had no pricing");
    expect(message).toContain("jazz daemon resume");
  });
});

describe("the daemon's daily pause reads the ledger", () => {
  it("reports the machine daily cap that blocks, by measure", () => {
    const today = day([{ costUSD: 2, tokens: 10_000 }]);

    expect(blockingMachineDailyCap({ dailyCostUSD: 2 }, windows(today))).toBe("cost");
    expect(blockingMachineDailyCap({ dailyCostUSD: 3 }, windows(today))).toBeUndefined();
    expect(blockingMachineDailyCap({ dailyTokens: 10_000 }, windows(today))).toBe("tokens");
    expect(blockingMachineDailyCap({ monthlyCostUSD: 1 }, windows(today))).toBeUndefined();
    expect(blockingMachineDailyCap({ dailyCostUSD: 3 }, windows(day([{ costKnown: false }])))).toBe(
      "cost",
    );
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
