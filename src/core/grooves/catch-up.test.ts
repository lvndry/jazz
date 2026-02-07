import { describe, expect, it } from "bun:test";
import { decideCatchUp } from "./catch-up";
import type { GrooveMetadata } from "./groove-service";

function createGroove(overrides: Partial<GrooveMetadata> = {}): GrooveMetadata {
  return {
    name: "market-analysis",
    description: "Daily market analysis",
    path: "/test",
    schedule: "0 6 * * *",
    catchUpOnStartup: true,
    ...overrides,
  };
}

describe("decideCatchUp", () => {
  it("should run when catch-up enabled and last run missed", () => {
    const groove = createGroove();
    const now = new Date(2026, 1, 3, 8, 0, 0); // Feb 3, 2026 8:00 local

    const decision = decideCatchUp(groove, undefined, now);
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe("missed run");
  });

  it("should not run when already ran after last schedule", () => {
    const groove = createGroove();
    const now = new Date(2026, 1, 3, 8, 0, 0);
    const lastRunAt = new Date(2026, 1, 3, 7, 0, 0);

    const decision = decideCatchUp(groove, lastRunAt, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("already ran");
  });

  it("should not run when catch-up disabled", () => {
    const groove = createGroove({ catchUpOnStartup: false });
    const now = new Date(2026, 1, 3, 8, 0, 0);

    const decision = decideCatchUp(groove, undefined, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("catch-up disabled");
  });

  it("should not run when missed run is too old", () => {
    const groove = createGroove({ maxCatchUpAge: 60 * 60 });
    const now = new Date(2026, 1, 4, 8, 0, 0); // Next day

    const decision = decideCatchUp(groove, undefined, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("missed window");
  });
});
