/**
 * `report_goal_cycle`: how a goal cycle says where the goal stands.
 *
 * Only a run started by a goal has this tool (see `runToolDenials`). It changes nothing by
 * itself: once the cycle ends, the goal worker reads the last successful call from the cycle's
 * messages and checks it against the plan and the cycle's own tool output, exactly as it would
 * a written disposition. Reporting through a tool keeps the cycle's visible answer ordinary prose.
 */
import { Effect } from "effect";
import { z } from "zod";
import {
  BLOCKED_ROUNDS_REQUIRED,
  blockedRuleInstruction,
  blockerKey,
  blockerRound,
} from "@/core/agent/goal/goal-blocker";
import { MAX_BLOCKER_CHARS } from "@/core/agent/goal/goal-evaluation";
import { CLAIMED_GOAL_STATES } from "@/core/agent/goal/goal-state";
import { GoalStoreTag } from "@/core/interfaces/goal-store";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";
import { lastSucceededToolCall, type ToolCallMessage } from "./tool-call-history";

export const REPORT_GOAL_CYCLE_TOOL_NAME = "report_goal_cycle";

const reportGoalCycleParameters = z
  .object({
    status: z
      .enum(["continue", "complete", "blocked", "question"])
      .describe(
        "continue: more work remains. complete: every goal success criterion is met. blocked: you cannot continue safely. question: you need a decision only the user can make.",
      ),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe("What this cycle did, or for blocked, what stops the work and why."),
    blocker: z
      .string()
      .min(1)
      .max(MAX_BLOCKER_CHARS)
      .optional()
      .describe(
        `For blocked: a short name for what stops the work. Use the identical text each cycle while the same thing still stands; the goal stops as blocked after ${BLOCKED_ROUNDS_REQUIRED} consecutive cycles report the same blocker.`,
      ),
    nextAction: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("For continue: the next bounded action."),
    completedStepIds: z
      .array(z.string())
      .max(8)
      .optional()
      .describe("For continue: ids of plan steps finished and verified in this cycle."),
    evidence: z
      .array(
        z.object({
          criterion: z.number().int().positive().describe("The success criterion's number."),
          quote: z
            .string()
            .min(1)
            .max(1200)
            .describe("Text copied from a tool result in this cycle that shows it is met."),
        }),
      )
      .optional()
      .describe("For complete: one entry per goal success criterion."),
    question: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("For question: what to ask the user."),
  })
  .strict();

type ReportGoalCycleArgs = z.infer<typeof reportGoalCycleParameters>;

export function createReportGoalCycleTool(): Tool<GoalStoreTag> {
  return defineTool<GoalStoreTag, ReportGoalCycleArgs>({
    name: REPORT_GOAL_CYCLE_TOOL_NAME,
    disclosure: "public",
    description:
      "Report where the goal stands at the end of this cycle: call it once, as the cycle's last tool call, then give the user a short update in plain words.",
    parameters: reportGoalCycleParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(reportGoalCycleParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        if (args.status !== "blocked") {
          return { success: true, result: { recorded: true } } satisfies ToolExecutionResult;
        }
        const blocker = blockerKey(args);
        const goals = yield* GoalStoreTag;
        const open = (yield* goals.list({ states: CLAIMED_GOAL_STATES })).find(
          (goal) => goal.cycle?.runId === context.runId,
        );
        const round = open === undefined ? 1 : blockerRound(open, blocker);
        return {
          success: true,
          result:
            round >= BLOCKED_ROUNDS_REQUIRED
              ? { recorded: true }
              : { recorded: true, instruction: blockedRuleInstruction(blocker, round) },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            success: true,
            result: { recorded: true },
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => (result.success ? "Goal progress reported" : undefined),
  });
}

/**
 * The arguments of the cycle's last successful `report_goal_cycle` call, as the JSON text a
 * disposition is validated from; undefined when it made none.
 */
export function goalCycleReport(messages: readonly ToolCallMessage[]): string | undefined {
  return lastSucceededToolCall(messages, REPORT_GOAL_CYCLE_TOOL_NAME);
}
