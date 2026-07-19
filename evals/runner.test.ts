import { describe, expect, it } from "bun:test";
import { aggregate, type PerTaskRollups } from "./runner";

describe("aggregate", () => {
  const perTask: PerTaskRollups[] = [
    { taskId: "r1", domain: "research", samples: [true, true, false], costUSD: 0.03 },
    { taskId: "r2", domain: "research", samples: [true, true, true], costUSD: 0.06 },
    { taskId: "t1", domain: "tooluse", samples: [false, false, false], costUSD: 0.02 },
  ];

  it("computes overall pass@1 as mean of per-task means", () => {
    // r1=2/3, r2=1, t1=0 -> mean = (0.6667+1+0)/3
    expect(aggregate(perTask).overall.passAt1).toBeCloseTo((2 / 3 + 1 + 0) / 3, 5);
  });

  it("computes pass@k (task solved at least once) and Pass^k (all samples pass)", () => {
    const overall = aggregate(perTask).overall;
    // pass@k: r1 and r2 have a pass, t1 none -> 2/3
    expect(overall.passAtK).toBeCloseTo(2 / 3, 5);
    // Pass^k: only r2 is all-pass -> 1/3
    expect(overall.passHatK).toBeCloseTo(1 / 3, 5);
  });

  it("splits metrics by domain", () => {
    const report = aggregate(perTask);
    expect(report.byDomain.research?.nTasks).toBe(2);
    expect(report.byDomain.tooluse?.passAt1).toBe(0);
    expect(report.byDomain.research?.passHatK).toBeCloseTo(0.5, 5); // r2 only, of 2
  });

  it("reports total cost and per-task reliability", () => {
    const report = aggregate(perTask);
    expect(report.totalCostUSD).toBeCloseTo(0.11, 5);
    expect(report.perTask.find((t) => t.taskId === "r2")?.passHatK).toBe(1);
  });

  it("is empty-safe", () => {
    const empty = aggregate([]);
    expect(empty.overall.passAt1).toBe(0);
    expect(empty.overall.nTasks).toBe(0);
  });
});
