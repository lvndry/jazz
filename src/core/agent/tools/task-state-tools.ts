import { Effect } from "effect";
import { z } from "zod";
import {
  formatTaskState,
  patchTaskState,
  readTaskState,
  type TaskState,
} from "@/core/agent/context/task-state";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

const workItemSchema = z.object({
  description: z.string().min(1).describe("What this piece of work is."),
  status: z
    .enum(["pending", "in_progress", "unverified", "done", "failing"])
    .describe(
      'Use "done" only when you have actually run something that confirms it works. ' +
        'If you believe it is finished but have not verified it, use "unverified".',
    ),
  verifiedBy: z
    .string()
    .optional()
    .describe(
      'What you ran to verify it, e.g. "bun test src/foo.test.ts". Required in spirit for "done".',
    ),
});

const updateTaskStateParameters = z
  .object({
    goal: z.string().optional().describe("What this task is ultimately trying to achieve."),
    constraints: z
      .array(z.string())
      .optional()
      .describe("Requirements or limits that must hold, e.g. 'must not change the public API'."),
    decisions: z
      .array(z.string())
      .optional()
      .describe("Choices made and why, so a later session does not relitigate them."),
    workItems: z.array(workItemSchema).optional().describe("The pieces of work and their status."),
    filesTouched: z.array(z.string()).optional().describe("Paths you have created or modified."),
    openQuestions: z.array(z.string()).optional().describe("Unresolved uncertainties."),
    nextStep: z.string().optional().describe("The single next action you intend to take."),
  })
  .strict();

type UpdateTaskStateArgs = z.infer<typeof updateTaskStateParameters>;

/**
 * Record where the current task stands, so it survives compaction and process death.
 *
 * Deliberately separate from memory: memory is what stays true about a person or project
 * for weeks, this is what is true about this task right now. Routing task detail into
 * memory would pollute it, which is why `MEMORY_INSTRUCTIONS` tells the agent not to.
 */
export function createUpdateTaskStateTool(): Tool<never> {
  return defineTool<never, UpdateTaskStateArgs>({
    name: "update_task_state",
    description:
      "Record where you are in the current task so it survives context compaction and " +
      "picking the work back up later. Call it when you settle on a goal or plan, finish " +
      "or fail a piece of work, make a decision worth not revisiting, or learn something " +
      "that changes the plan — not at the end, since you may never get a clean ending. " +
      "Only the fields you pass are changed; the rest are left as they were. This is for " +
      "THIS task's state, not durable facts about the person or project — those belong in " +
      "memory. Mark work 'done' only when you have run something that confirms it; use " +
      "'unverified' when you believe it works but have not checked.",
    parameters: updateTaskStateParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(updateTaskStateParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const conversationId = context.conversationId;
        if (!conversationId) {
          return {
            success: false,
            result: null,
            error: "No conversation is active, so there is no task state to update.",
          } satisfies ToolExecutionResult;
        }

        // Only keys actually supplied become a patch — an omitted field must not be
        // read as "clear this".
        const patch: Partial<TaskState> = {
          ...(args.goal !== undefined && { goal: args.goal }),
          ...(args.constraints !== undefined && { constraints: args.constraints }),
          ...(args.decisions !== undefined && { decisions: args.decisions }),
          ...(args.workItems !== undefined && { workItems: args.workItems }),
          ...(args.filesTouched !== undefined && { filesTouched: args.filesTouched }),
          ...(args.openQuestions !== undefined && { openQuestions: args.openQuestions }),
          ...(args.nextStep !== undefined && { nextStep: args.nextStep }),
        };

        if (Object.keys(patch).length === 0) {
          const current = yield* readTaskState(context.agentId, conversationId);
          return {
            success: true,
            result: {
              formatted: formatTaskState(current) ?? "No task state recorded yet.",
              state: current ?? {},
            },
          } satisfies ToolExecutionResult;
        }

        const merged = yield* patchTaskState(
          context.agentId,
          conversationId,
          patch,
          new Date().toISOString(),
        );

        return {
          success: true,
          result: {
            formatted: formatTaskState(merged) ?? "Task state updated.",
            state: merged,
          },
        } satisfies ToolExecutionResult;
      }),
  });
}
