import { describe, expect, it } from "bun:test";
import { canTransitionGoal, transitionGoal } from "./goal-state";

describe("goal lifecycle transitions", () => {
  it("fences an active run before pause or cancellation", () => {
    expect(canTransitionGoal("active", "stopping")).toBe(true);
    expect(transitionGoal({ kind: "active" }, { kind: "stopping" })).toEqual({ kind: "stopping" });
    expect(canTransitionGoal("stopping", "paused")).toBe(true);
    expect(canTransitionGoal("stopping", "canceled")).toBe(true);
    expect(canTransitionGoal("stopping", "paused")).toBe(true);
    expect(canTransitionGoal("active", "canceled")).toBe(true);
  });

  it("allows a reconciled in-flight result to settle while paused", () => {
    expect(canTransitionGoal("paused", "completed")).toBe(true);
    expect(canTransitionGoal("paused", "review-required")).toBe(true);
    expect(canTransitionGoal("completed", "active")).toBe(false);
  });
});
