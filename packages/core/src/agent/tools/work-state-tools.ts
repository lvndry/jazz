import { Effect } from "effect";
import { z } from "zod";
import {
  formatWorkState,
  patchWorkState,
  readWorkState,
  type WorkState,
} from "@/core/agent/context/work-state";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

const updateWorkStateParameters = z
  .object({
    goal: z.string().optional().describe("What this task is ultimately trying to achieve."),
    constraints: z
      .array(z.string())
      .optional()
      .describe("Requirements or limits that must hold, e.g. 'must not change the public API'."),
    decisions: z
      .array(z.string())
      .optional()
      .describe("Choices made and why, so whoever picks this up later does not relitigate them."),
    filesTouched: z.array(z.string()).optional().describe("Paths you have created or modified."),
    openQuestions: z.array(z.string()).optional().describe("Unresolved uncertainties."),
    nextStep: z.string().optional().describe("The single next action you intend to take."),
  })
  .strict();

type UpdateWorkStateArgs = z.infer<typeof updateWorkStateParameters>;

/**
 * Record where the current task stands, so it survives compaction and process death.
 *
 * Deliberately separate from memory: memory is what stays true about a person or project
 * for weeks, this is what is true about this task right now. Routing task detail into
 * memory would pollute it, so the distinction is documented directly in this tool's description.
 */
export function createUpdateWorkStateTool(): Tool<never> {
  return defineTool<never, UpdateWorkStateArgs>({
    name: "update_work_state",
    disclosure: "private",
    description:
      "Read or update the current task state so progress survives context compaction or resumption. " +
      "Update it when the goal, constraints, decisions, touched files, open questions, or next step " +
      "materially change. This is temporary task context, not long-term memory or a todo list. " +
      "Omitted fields remain unchanged; call with no fields to read the current state.",
    parameters: updateWorkStateParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(updateWorkStateParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const conversationId = context.conversationId;
        if (!conversationId) {
          return {
            success: false,
            result: null,
            error: "No conversation is active, so there is no work state to update.",
          } satisfies ToolExecutionResult;
        }

        // Only keys actually supplied become a patch — an omitted field must not be
        // read as "clear this".
        const patch: Partial<WorkState> = {
          ...(args.goal !== undefined && { goal: args.goal }),
          ...(args.constraints !== undefined && { constraints: args.constraints }),
          ...(args.decisions !== undefined && { decisions: args.decisions }),
          ...(args.filesTouched !== undefined && { filesTouched: args.filesTouched }),
          ...(args.openQuestions !== undefined && { openQuestions: args.openQuestions }),
          ...(args.nextStep !== undefined && { nextStep: args.nextStep }),
        };

        if (Object.keys(patch).length === 0) {
          const current = yield* readWorkState(context.agentId, conversationId);
          return {
            success: true,
            result: {
              formatted: formatWorkState(current) ?? "No task state recorded yet.",
              state: current ?? {},
            },
          } satisfies ToolExecutionResult;
        }

        const merged = yield* patchWorkState(
          context.agentId,
          conversationId,
          patch,
          new Date().toISOString(),
        );

        return {
          success: true,
          result: {
            formatted: formatWorkState(merged) ?? "Task state updated.",
            state: merged,
          },
        } satisfies ToolExecutionResult;
      }),
  });
}
