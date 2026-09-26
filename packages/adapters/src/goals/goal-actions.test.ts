import { getGoalOwnerInstanceId } from "@jazz/core/agent/goal/goal-owner";
import { testGoalPlan, testProposedGoal } from "@jazz/core/agent/goal/test-fixtures";
import { silentLogger } from "@jazz/core/agent/test-logger";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { GoalStoreTag } from "@jazz/core/interfaces/goal-store";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { ToolRegistryTag, type ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { activateGoal, controlGoal, proposeGoal } from "@jazz/adapters/goals/goal-actions";
import { InMemoryGoalStore } from "@jazz/adapters/storage/goal-store";
import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";

const LOCAL_AGENT = {
  id: "agent-1",
  name: "agent",
  config: { persona: "default", llmProvider: "ollama", llmModel: "qwen3:8b" },
} as unknown as Agent;

const DRAFT = JSON.stringify({
  kind: "plan",
  objective: "Header test passes",
  successCriteria: ["The header test passes"],
  constraints: [],
  assumptions: [],
  feasibility: { assessment: "plausible", rationale: "Small change." },
  steps: [{ id: "fix", objective: "Fix parser", successCriteria: ["Test passes"] }],
  verification: ["bun test"],
});

function layer(goals: InMemoryGoalStore) {
  const llm = {
    createChatCompletion: () =>
      Effect.succeed({
        id: "plan",
        model: "qwen3:8b",
        content: DRAFT,
        usage: { promptTokens: 900, completionTokens: 300, totalTokens: 1_200 },
      }),
  } as unknown as LLMService;
  return Layer.mergeAll(
    Layer.succeed(GoalStoreTag, goals),
    Layer.succeed(RunStoreTag, new InMemoryRunStore()),
    Layer.succeed(LLMServiceTag, llm),
    Layer.succeed(ToolRegistryTag, {} as ToolRegistry),
    Layer.succeed(LoggerServiceTag, silentLogger),
    Layer.succeed(AgentServiceTag, {} as AgentService),
  );
}

/** Only the services these paths reach are provided; a discovery run is never started here. */
function run<A, E>(goals: InMemoryGoalStore, effect: Effect.Effect<A, E, unknown>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer(goals))) as Effect.Effect<A, E>);
}

describe("goal planning spend", () => {
  it("prices the planner call and charges it to the goal it starts", async () => {
    const goals = new InMemoryGoalStore();
    const proposal = await run(
      goals,
      proposeGoal({ agent: LOCAL_AGENT, request: "Fix the header test", inspect: false }),
    );
    if (proposal.kind !== "plan") {
      throw new Error("expected a plan");
    }
    expect(proposal.spend.totalTokens).toBe(1_200);
    expect(proposal.spend.costUSD).toBe(0);

    const activation = await run(
      goals,
      activateGoal({
        agent: LOCAL_AGENT,
        workingDirectory: "/work/importer",
        request: "Fix the header test",
        plan: proposal.plan,
        spend: proposal.spend,
      }),
    );
    if (activation.kind !== "active") {
      throw new Error("expected an active goal");
    }
    expect(activation.goal.usage).toMatchObject({
      totalTokens: 1_200,
      costKnown: true,
      costUSD: 0,
    });
  });

  it("keeps an unpriced planning spend unknown instead of calling it free", async () => {
    const goals = new InMemoryGoalStore();
    const activation = await run(
      goals,
      activateGoal({
        agent: LOCAL_AGENT,
        workingDirectory: "/work/importer",
        request: "Fix the header test",
        plan: testGoalPlan(),
        spend: { totalTokens: 5_000, startedAt: Date.now() },
      }),
    );
    if (activation.kind !== "active") {
      throw new Error("expected an active goal");
    }
    expect(activation.goal.usage.costKnown).toBe(false);
    expect(activation.goal.usage.costUSD).toBeUndefined();
    expect(activation.goal.usage.totalTokens).toBe(5_000);
  });
});

describe("controlGoal", () => {
  it("tells a missing goal from one that moved past the caller's version", async () => {
    const goals = new InMemoryGoalStore();
    const proposed = await run(
      goals,
      goals.create(testProposedGoal({ ownerInstanceId: getGoalOwnerInstanceId() })),
    );

    const missing = await run(goals, controlGoal("no-such-goal", "accept"));
    expect(missing).toMatchObject({ kind: "refused", cause: "missing" });

    const stale = await run(
      goals,
      controlGoal(proposed.goalId, "accept", { expectedVersion: proposed.version + 1 }),
    );
    expect(stale).toMatchObject({ kind: "refused", cause: "changed" });

    const accepted = await run(
      goals,
      controlGoal(proposed.goalId, "accept", { expectedVersion: proposed.version }),
    );
    expect(accepted.kind).toBe("applied");
    if (accepted.kind === "applied") {
      expect(accepted.goal.state.kind).toBe("active");
    }

    const again = await run(goals, controlGoal(proposed.goalId, "decline"));
    expect(again).toMatchObject({ kind: "refused", cause: "refused" });
  });
});

describe("activating a goal", () => {
  /** The regression: a refused accept left the goal it had just created behind as a proposal. */
  it("cancels the goal it created when accepting it is refused", async () => {
    const goals = new InMemoryGoalStore();
    const accept = goals.compareAndSet.bind(goals);
    let refusedOnce = false;
    goals.compareAndSet = ((goalId, version, next) => {
      if (!refusedOnce && next.state.kind === "active") {
        refusedOnce = true;
        return Effect.fail(new Error("another writer moved the goal first"));
      }
      return accept(goalId, version, next);
    }) as typeof goals.compareAndSet;
    const proposal = await run(
      goals,
      proposeGoal({ agent: LOCAL_AGENT, request: "Fix the header test", inspect: false }),
    );
    if (proposal.kind !== "plan") {
      throw new Error("expected a plan");
    }
    const activation = await run(
      goals,
      activateGoal({
        agent: LOCAL_AGENT,
        workingDirectory: "/work/importer",
        request: "Fix the header test",
        plan: proposal.plan,
        spend: proposal.spend,
      }),
    );
    expect(activation.kind).toBe("refused");
    const stored = await run(goals, goals.list({}));
    expect(stored.map((goal) => goal.state.kind)).toEqual(["canceled"]);
  });
});
