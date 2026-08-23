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
 * memory would pollute it, which is why `MEMORY_INSTRUCTIONS` tells the agent not to.
 */
export function createUpdateWorkStateTool(): Tool<never> {
  return defineTool<never, UpdateWorkStateArgs>({
    name: "update_work_state",
    description:
      "Record where you are in the current task so it survives context compaction and " +
      "picking the work back up later. Call it when you settle on a goal or plan, finish " +
      "or fail a piece of work, make a decision worth not revisiting, or learn something " +
      "that changes the plan — not at the end, since you may never get a clean ending. " +
      "Only the fields you pass are changed; the rest are left as they were. This is for " +
      "THIS task's state, not durable facts about the person or project — those belong in " +
      "memory. Call with no fields to read the current state. The list of work itself " +
      "belongs in manage_todos, not here — this is the intent around it.",
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
