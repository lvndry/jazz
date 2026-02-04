import { describe, expect, it } from "bun:test";
import { decideCatchUp } from "./catch-up";
import type { WorkflowMetadata } from "./workflow-service";

function createWorkflow(overrides: Partial<WorkflowMetadata> = {}): WorkflowMetadata {
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
    const workflow = createWorkflow();
    const now = new Date(2026, 1, 3, 8, 0, 0); // Feb 3, 2026 8:00 local

    const decision = decideCatchUp(workflow, undefined, now);
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe("missed run");
  });

  it("should not run when already ran after last schedule", () => {
    const workflow = createWorkflow();
    const now = new Date(2026, 1, 3, 8, 0, 0);
    const lastRunAt = new Date(2026, 1, 3, 7, 0, 0);

    const decision = decideCatchUp(workflow, lastRunAt, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("already ran");
  });

  it("should not run when catch-up disabled", () => {
    const workflow = createWorkflow({ catchUpOnStartup: false });
    const now = new Date(2026, 1, 3, 8, 0, 0);

    const decision = decideCatchUp(workflow, undefined, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("catch-up disabled");
  });

  it("should not run when missed run is too old", () => {
    const workflow = createWorkflow({ maxCatchUpAge: 60 * 60 });
    const now = new Date(2026, 1, 4, 8, 0, 0); // Next day

    const decision = decideCatchUp(workflow, undefined, now);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe("missed window");
  });
});
