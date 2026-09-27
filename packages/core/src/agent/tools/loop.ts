/**
 * `end_loop`: a loop's own run ending the loop, e.g. once what it was watching for happened.
 *
 * Only a run started by a loop has this tool (see `runToolDenials`). It changes nothing by
 * itself: the daemon reads a successful call from the run it just finished and completes the
 * loop with the reason given, after folding in that run's spend like any other.
 */
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

export const END_LOOP_TOOL_NAME = "end_loop";

const endLoopParameters = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(300)
      .describe("Why the loop is done, shown to the user (e.g. what it was waiting for happened)."),
  })
  .strict();

type EndLoopArgs = z.infer<typeof endLoopParameters>;

export function createEndLoopTool(): Tool<never> {
  return defineTool<never, EndLoopArgs>({
    name: END_LOOP_TOOL_NAME,
    disclosure: "public",
    description:
      "End the loop this run belongs to, so it does not run again: call it when the loop's purpose is met or it can no longer make progress. The loop stops after this run.",
    parameters: endLoopParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(endLoopParameters),
    handler: (args) =>
      Effect.succeed({
        success: true,
        result: { ended: true, reason: args.reason },
      } satisfies ToolExecutionResult),
    createSummary: (result) => (result.success ? "Loop will end after this run" : undefined),
  });
}
