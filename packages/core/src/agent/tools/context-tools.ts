/**
 * Self-awareness tools exposed to the model: current date/time, context
 * window usage, and retrieval of tool output that was offloaded from context.
 */

import { Effect } from "effect";
import { z } from "zod";
import { readOffloadedToolResult } from "@/core/agent/context/tool-result-offload";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Create the get_time tool for current date/time awareness.
 * Returns ISO timestamp, local date, day of week, and timezone for scheduling and relative time reasoning.
 */
export function createGetTimeTool(): Tool<never> {
  return {
    name: "get_time",
    disclosure: "internal",
    description:
      "Get the current date and time. The Environment block already has today's date — use this only when you need a fresh clock during a long run, for scheduling, relative times such as 'yesterday', or timestamps.",
    parameters: z.object({}).strict(),
    riskLevel: "read-only",
    hidden: false,
    createSummary: undefined,
    execute: () => {
      const now = new Date();
      const iso = now.toISOString();
      const dayOfWeek = DAYS[now.getDay()];
      const localDate = now.toLocaleDateString();
      const localTime = now.toLocaleTimeString();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return Effect.succeed({
        success: true,
        result: {
          iso,
          timestamp: now.getTime(),
          dayOfWeek,
          localDate,
          localTime,
          timezone,
        },
      } satisfies ToolExecutionResult);
    },
  };
}

/**
 * Create the context_info tool for token budget awareness.
 * Allows agents to query current context window usage statistics.
 */
export function createContextInfoTool(): Tool<never> {
  return {
    name: "context_info",
    disclosure: "internal",
    description:
      "Report how much of the context window is in use. The harness already warns at 70% and 90% and auto-compacts around 80%. Do not poll this. If you need to free space now, call summarize_context.",
    parameters: z.object({}),
    riskLevel: "read-only",
    hidden: false,
    createSummary: undefined,
    execute: (_args, context) => {
      // Token stats are passed via context from the executor
      const currentTokens = context.tokenStats?.currentTokens ?? 0;
      const maxTokens = context.tokenStats?.maxTokens ?? 50_000;
      const percentUsed = Math.round((currentTokens / maxTokens) * 100);
      const remainingTokens = maxTokens - currentTokens;

      let recommendation: string;
      if (percentUsed < 50) {
        recommendation = "Context budget is healthy. Proceed normally.";
      } else if (percentUsed < 80) {
        recommendation = "Context is moderately used. Consider being concise.";
      } else {
        recommendation =
          "Context is limited. Complete current task or consider summarizing earlier context.";
      }

      return Effect.succeed({
        success: true,
        result: {
          estimatedTokensUsed: currentTokens,
          maxTokens,
          remainingTokens,
          percentUsed,
          recommendation,
        },
      } satisfies ToolExecutionResult);
    },
  };
}

const retrieveToolResultParameters = z
  .object({
    tool_call_id: z
      .string()
      .min(1)
      .describe("The tool_call_id from the offloaded placeholder you want to read back."),
  })
  .strict();

type RetrieveToolResultArgs = z.infer<typeof retrieveToolResultParameters>;

/**
 * Read a tool body that was moved out of context onto disk.
 *
 * The original tool may no longer be in the transcript. This is the pointer
 * the clearer leaves behind. Missing files (read-only hosts that never wrote,
 * or a body below the size floor) return an error telling the model to re-run
 * the original tool instead.
 */
export function createRetrieveToolResultTool(): Tool<never> {
  return defineTool<never, RetrieveToolResultArgs>({
    name: "retrieve_tool_result",
    disclosure: "private",
    description:
      "Read the original output of a tool result that was offloaded from context. " +
      "Pass the tool_call_id from the offloaded placeholder. If nothing is stored, " +
      "re-run the original tool instead — the host may be read-only.",
    parameters: retrieveToolResultParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(retrieveToolResultParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const conversationId = context.conversationId;
        if (!conversationId) {
          return {
            success: false,
            result: null,
            error: "No conversation is active, so there is nothing to retrieve.",
          } satisfies ToolExecutionResult;
        }

        const contents = yield* readOffloadedToolResult(
          context.agentId,
          conversationId,
          args.tool_call_id,
        );
        if (contents === undefined) {
          return {
            success: false,
            result: null,
            error:
              `No offloaded result for tool_call_id "${args.tool_call_id}". ` +
              "Re-run the original tool if you still need that output.",
          } satisfies ToolExecutionResult;
        }

        return { success: true, result: contents } satisfies ToolExecutionResult;
      }),
  });
}
