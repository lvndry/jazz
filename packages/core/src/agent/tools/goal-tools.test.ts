import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { parseGoalRecord, type GoalRecord } from "@/core/agent/goal/goal-record";
import { GoalStoreTag, type GoalStore } from "@/core/interfaces/goal-store";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createProposeGoalTool, planFromProposal } from "./goal-tools";

const PROPOSAL = {
  objective: "Every recipe in recipes/ uses the new frontmatter format",
  successCriteria: ["`bun run check-recipes` reports 0 invalid files"],
  steps: [
    { objective: "Convert the recipes", doneWhen: "Every file has frontmatter" },
    { objective: "Validate them", doneWhen: "The checker passes" },
  ],
  feasibility: { assessment: "plausible" as const, rationale: "40 small files and a checker." },
};

function recordingStore(): { store: GoalStore; created: Omit<GoalRecord, "version">[] } {
  const created: Omit<GoalRecord, "version">[] = [];
  const store = {
    create: (record: Omit<GoalRecord, "version">) =>
      Effect.sync(() => {
        created.push(record);
        return { ...record, version: 1 };
      }),
  } as unknown as GoalStore;
  return { store, created };
}

function run(context: ToolExecutionContext, store: GoalStore) {
  return Effect.runPromise(
    createProposeGoalTool()
      .execute(PROPOSAL, context)
      .pipe(Effect.provideService(GoalStoreTag, store)),
  );
}

describe("propose_goal", () => {
  it("turns the proposal into a plan with one checked milestone per step", () => {
    const plan = planFromProposal(PROPOSAL);
    expect(plan.steps.map((step) => [step.id, step.successCriteria])).toEqual([
      ["step-1", ["Every file has frontmatter"]],
      ["step-2", ["The checker passes"]],
    ]);
    expect(plan.verification).toEqual(PROPOSAL.successCriteria);
  });

  it("saves a proposed goal holding the user's own words, which nothing runs until accepted", async () => {
    const { store, created } = recordingStore();
    const result = await run(
      {
        agentId: "agent-1",
        conversationId: "chat-1",
        conversationMessages: [
          {
            role: "user",
            content:
              "Migrate all my recipes to the new format and keep going until the checker passes.",
          },
          { role: "assistant", content: "Let me look." },
        ],
      },
      store,
    );

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
    const goal = created[0]!;
    expect(goal.state).toEqual({ kind: "proposed" });
    expect(goal.sourceConversationId).toBe("chat-1");
    expect(goal.request).toBe(
      "Migrate all my recipes to the new format and keep going until the checker passes.",
    );
    expect(parseGoalRecord({ ...goal, version: 1 }).ok).toBe(true);
  });

  it("refuses when a subagent tries to propose a goal", async () => {
    const { store, created } = recordingStore();
    const result = await run({ agentId: "agent-1", subagentDepth: 1 }, store);
    expect(result.success).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("rejects a plan without observable success criteria and saves nothing", async () => {
    const { store, created } = recordingStore();
    const result = await Effect.runPromise(
      createProposeGoalTool()
        .execute({ ...PROPOSAL, successCriteria: [] }, { agentId: "agent-1" })
        .pipe(Effect.provideService(GoalStoreTag, store)),
    );
    expect(result.success).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("cannot grant the goal any authority: the proposal schema has no such field", async () => {
    const { store, created } = recordingStore();
    const result = await Effect.runPromise(
      createProposeGoalTool()
        .execute({ ...PROPOSAL, approvalPolicy: "high-risk" }, { agentId: "agent-1" })
        .pipe(Effect.provideService(GoalStoreTag, store)),
    );
    expect(result.success).toBe(false);
    expect(created).toHaveLength(0);
  });
});
