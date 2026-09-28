import type { CapStatus } from "@jazz/core/spend/caps";
import { describe, expect, it } from "bun:test";
import { describeCap } from "./spend";

const machineDaily: CapStatus = {
  key: "daemon.dailyCostUSD",
  scope: { kind: "machine" },
  period: "day",
  measure: "cost",
  limit: 1,
  spent: 2,
  unpricedRuns: 0,
  reached: true,
  unverifiable: false,
};

describe("describeCap", () => {
  it("shows a reached cap as reached", () => {
    expect(describeCap(machineDaily, 20)).toContain("REACHED");
  });

  it("shows a reached cap `jazz daemon resume` lifted as lifted, with until when", () => {
    const liftedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const line = describeCap({ ...machineDaily, liftedUntil }, 20);

    expect(line).toContain(`lifted until ${new Date(liftedUntil).toLocaleString()}`);
    expect(line).not.toContain("REACHED");
  });

  it("shows an unverifiable daily cap as blocked by its unpriced runs", () => {
    const line = describeCap(
      { ...machineDaily, spent: 0.5, reached: false, unverifiable: true, unpricedRuns: 2 },
      20,
    );

    expect(line).toContain("BLOCKED: 2 unpriced runs today");
  });

  it("pads the key to the width it is given", () => {
    expect(describeCap(machineDaily, 25)).toStartWith(
      `  ${"daemon.dailyCostUSD".padEnd(25)}  $2.00`,
    );
  });
});
