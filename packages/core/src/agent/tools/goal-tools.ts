/**
 * `propose_goal`: the agent's way into goal mode.
 *
 * When a request needs sustained work across several runs, the agent proposes a plan with
 * this tool instead of trying to finish it in one turn. The proposal is saved as a goal in
 * the `proposed` state and nothing runs yet: the surface asks the user to accept it (chat
 * asks right after the turn; `jazz goal accept` does it elsewhere), and only then does the
 * daemon start working through it. Plan acceptance is the user's decision and is never
 * implied by the approval policy.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { getGoalOwnerInstanceId } from "@/core/agent/goal/goal-owner";
import type { GoalPlan } from "@/core/agent/goal/goal-record";
import { DEFAULT_GOAL_BUDGET } from "@/core/agent/goal/goal-usage";
import { GoalStoreTag } from "@/core/interfaces/goal-store";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import { defineTool, makeZodValidator } from "./base-tool";

export const PROPOSE_GOAL_TOOL_NAME = "propose_goal";

const text = (description: string) => z.string().min(1).max(500).describe(description);

const proposeGoalParameters = z
  .object({
    objective: z.string().min(1).max(1000).describe("The outcome the user wants, in one sentence."),
    successCriteria: z
      .array(text("One criterion."))
      .min(1)
      .max(8)
      .describe(
        "Checks that together mean the goal is done, each one something a command or tool can print when it holds (a test run, a file's content, a check that echoes a confirmation).",
      ),
    steps: z
      .array(
        z
          .object({
            objective: text("What this milestone achieves."),
            doneWhen: text("How you will know it is done."),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .describe("Intermediate milestones, in order, each with how you will know it is done."),
    constraints: z
      .array(text("One constraint."))
      .max(8)
      .optional()
      .describe("What must not change or be done."),
    feasibility: z
      .object({
        assessment: z
          .enum(["plausible", "uncertain", "unlikely"])
          .describe("plausible, uncertain, or unlikely."),
        rationale: z.string().min(1).max(1000).describe("Why, from what you have seen."),
      })
      .strict()
      .describe("Whether the objective looks achievable from what you have seen, and why."),
  })
  .strict();

type ProposeGoalArgs = z.infer<typeof proposeGoalParameters>;

export function planFromProposal(args: ProposeGoalArgs): GoalPlan {
  return {
    revision: 1,
    objective: args.objective,
    successCriteria: args.successCriteria,
    constraints: args.constraints ?? [],
    assumptions: [],
    feasibility: args.feasibility,
    steps: args.steps.map((step, index) => ({
      id: `step-${index + 1}`,
      objective: step.objective,
      successCriteria: [step.doneWhen],
      state: "pending" as const,
    })),
    verification: args.successCriteria,
  };
}

export function createProposeGoalTool(): Tool<GoalStoreTag> {
  return defineTool<GoalStoreTag, ProposeGoalArgs>({
    name: PROPOSE_GOAL_TOOL_NAME,
    disclosure: "public",
    description:
      "Propose a goal the user asked for that needs sustained work across several sessions, e.g. reaching a target, migrating many items, or keeping at something until it is done. " +
      "Not for work you can finish now: do that directly. Ask first when a missing choice changes the scope or the finish line, and look at the relevant files before proposing when feasibility depends on them. " +
      "Nothing runs until the user accepts the plan; after calling this, tell the user what you proposed and stop.",
    parameters: proposeGoalParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(proposeGoalParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        if ((context.subagentDepth ?? 0) > 0) {
          return {
            success: false,
            result: null,
            error: "Only the agent talking to the user can propose a goal.",
          } satisfies ToolExecutionResult;
        }
        const store = yield* GoalStoreTag;
        const request =
          [...(context.conversationMessages ?? [])]
            .reverse()
            .find((message) => message.role === "user")?.content ?? args.objective;
        const now = new Date().toISOString();
        const goal = yield* store.create({
          goalId: randomUUID(),
          ownerInstanceId: getGoalOwnerInstanceId(),
          agentId: context.agentId,
          ...(context.conversationId !== undefined
            ? { sourceConversationId: context.conversationId }
            : {}),
          conversationId: generateConversationId("goal"),
          request,
          plan: planFromProposal(args),
          state: { kind: "proposed" },
          budget: DEFAULT_GOAL_BUDGET,
          usage: { cycles: 0, totalTokens: 0, costKnown: true, costUSD: 0, activeDurationMs: 0 },
          createdAt: now,
          updatedAt: now,
        });
        return {
          success: true,
          result: {
            goalId: goal.goalId,
            state: "proposed",
            next: "The user is asked to accept this plan after your reply. Summarize it briefly and stop; do not start the work in this turn.",
          },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => (result.success ? "Goal proposed" : undefined),
  });
}
