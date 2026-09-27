import { describe, expect, it } from "bun:test";
import { ceilingStatuses, evaluateSpendCeilings } from "./ceilings";
import { addEntryToDay, EMPTY_DAY, type DaySpend } from "./ledger";
import { SPEND_SOURCES } from "./sources";
import { isUnattendedSource } from "./sources";

function day(
  runs: ReadonlyArray<{
    agentId?: string;
    source?: (typeof SPEND_SOURCES)[number];
    costUSD: number;
    costKnown?: boolean;
  }>,
): DaySpend {
  return runs.reduce(
    (spend, run) =>
      addEntryToDay(spend, {
        at: new Date().toISOString(),
        agentId: run.agentId ?? "a",
        source: run.source ?? "workflow",
        costUSD: run.costUSD,
        costKnown: run.costKnown ?? true,
        tokens: 1,
      }),
    EMPTY_DAY,
  );
}

describe("evaluateSpendCeilings", () => {
  it("is clear with no spend config, however much was spent", () => {
    const today = day([{ costUSD: 1_000 }]);

    expect(
      evaluateSpendCeilings(undefined, { today, month: today }, { agentId: "a", source: "run" }),
    ).toEqual({
      kind: "clear",
    });
  });

  it("reports the machine day ceiling once today's spend reaches it", () => {
    const today = day([{ costUSD: 3 }, { costUSD: 2 }]);

    const check = evaluateSpendCeilings(
      { dayUSD: 5 },
      { today, month: today },
      { agentId: "a", source: "workflow" },
    );

    expect(check).toMatchObject({ kind: "reached", period: "day", limitUSD: 5, spentUSD: 5 });
  });

  it("applies the goals ceilings to goal and loop runs only", () => {
    const today = day([
      { source: "goal", costUSD: 4 },
      { source: "loop", costUSD: 1 },
    ]);
    const spend = { goals: { dayUSD: 5 } };

    expect(
      evaluateSpendCeilings(spend, { today, month: today }, { agentId: "a", source: "loop" }).kind,
    ).toBe("reached");
    expect(
      evaluateSpendCeilings(spend, { today, month: today }, { agentId: "a", source: "workflow" })
        .kind,
    ).toBe("clear");
  });

  it("counts only the agent's own runs against its ceiling", () => {
    const today = day([
      { agentId: "other", costUSD: 10 },
      { agentId: "mine", costUSD: 1 },
    ]);
    const spend = { agents: { mine: { dayUSD: 2 } } };

    expect(
      evaluateSpendCeilings(spend, { today, month: today }, { agentId: "mine", source: "run" })
        .kind,
    ).toBe("clear");
  });

  it("fails a day ceiling closed when a run today had no pricing", () => {
    const today = day([{ costUSD: 0, costKnown: false }]);

    expect(
      evaluateSpendCeilings(
        { dayUSD: 5 },
        { today, month: today },
        { agentId: "a", source: "run" },
      ),
    ).toMatchObject({ kind: "unverifiable", unpricedRuns: 1 });
  });

  it("checks a month ceiling against the month's priced spend", () => {
    const today = day([{ costUSD: 1 }]);
    const month = day([{ costUSD: 19 }, { costUSD: 1 }, { costUSD: 0, costKnown: false }]);

    expect(
      evaluateSpendCeilings({ monthUSD: 20 }, { today, month }, { agentId: "a", source: "run" }),
    ).toMatchObject({ kind: "reached", period: "month", spentUSD: 20 });
    expect(
      evaluateSpendCeilings({ monthUSD: 25 }, { today, month }, { agentId: "a", source: "run" })
        .kind,
    ).toBe("clear");
  });
});

describe("which entry points a reached ceiling refuses", () => {
  it("refuses every unattended source and lets chat, bots and answered resumes through", () => {
    const attended = SPEND_SOURCES.filter((source) => !isUnattendedSource(source));

    expect(attended).toEqual(["chat", "bot", "resume"]);
    for (const source of [
      "run",
      "workflow",
      "goal",
      "loop",
      "wake-trigger",
      "job",
      "webhook",
      "peer",
      "daemon",
      "detached",
    ] as const) {
      expect(isUnattendedSource(source)).toBe(true);
    }
  });
});

describe("ceilingStatuses", () => {
  it("lists every configured ceiling with its window's spend", () => {
    const today = day([{ source: "goal", costUSD: 1 }]);

    const statuses = ceilingStatuses(
      { dayUSD: 10, goals: { monthUSD: 1 } },
      { today, month: today },
    );

    expect(statuses.map((status) => [status.key, status.spentUSD, status.reached])).toEqual([
      ["spend.dayUSD", 1, false],
      ["spend.goals.monthUSD", 1, true],
    ]);
  });
});
