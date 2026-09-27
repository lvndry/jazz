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

export function createReportGoalCycleTool(): Tool<never> {
  return defineTool<never, ReportGoalCycleArgs>({
    name: REPORT_GOAL_CYCLE_TOOL_NAME,
    disclosure: "public",
    description:
      "Report where the goal stands at the end of this cycle: call it once, as the cycle's last tool call, then give the user a short update in plain words.",
    parameters: reportGoalCycleParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(reportGoalCycleParameters),
    handler: () =>
      Effect.succeed({
        success: true,
        result: { recorded: true },
      } satisfies ToolExecutionResult),
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
