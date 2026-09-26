/**
 * Goal records and plans for tests. Each builder returns a valid default that a test narrows
 * with overrides, so a test states only the fields its assertion depends on.
 */
import type { GoalPlan, GoalRecord, GoalRecordInput } from "./goal-record";

export function testGoalPlan(overrides: Partial<GoalPlan> = {}): GoalPlan {
  return {
    revision: 1,
    objective: "Header test passes",
    successCriteria: ["The header test passes"],
    constraints: [],
    assumptions: [],
    feasibility: { assessment: "plausible", rationale: "Small change." },
    steps: [
      { id: "fix", objective: "Fix parser", successCriteria: ["Test passes"], state: "pending" },
    ],
    verification: ["bun test"],
    ...overrides,
  };
}

/** An accepted, active goal with no cycle claimed yet. */
export function testGoal(overrides: Partial<GoalRecordInput> = {}): GoalRecordInput {
  return {
    goalId: "goal-1",
    ownerInstanceId: "owner",
    agentId: "agent-1",
    sourceConversationId: "chat",
    conversationId: "goal-chat",
    request: "Make the header test pass",
    plan: testGoalPlan(),
    approvedPlanRevision: 1,
    state: { kind: "active" },
    budget: { maxCycles: 5, maxTokens: 100_000, maxDurationMs: 600_000 },
    usage: { cycles: 0, totalTokens: 0, activeDurationMs: 0, costKnown: false },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

/** A goal proposed by the agent and not yet accepted. */
export function testProposedGoal(overrides: Partial<GoalRecordInput> = {}): GoalRecordInput {
  const { approvedPlanRevision: _approvedPlanRevision, ...goal } = testGoal();
  return { ...goal, state: { kind: "proposed" }, ...overrides };
}

/** A stored goal: a record at `version`. */
export function testStoredGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const { version, ...input } = overrides;
  return { ...testGoal(input), version: version ?? 1 };
}
