/**
 * Self-awareness tools exposed to the model: current date/time, context
 * window usage, and retrieval of tool output that was offloaded from context.
 */

import { Effect } from "effect";
import { z } from "zod";
import {
  readOffloadedToolResult,
  readOffloadedToolResultProvenance,
} from "@/core/agent/context/tool-result-offload";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { VERY_WIDE_PAYLOAD_MAX_CHARS } from "@/core/utils/tool-result-formatter";
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
      "Get the current date and time, for a fresh clock in long runs, scheduling or relative times. Today's date is already in the Environment block.",
    parameters: z.object({}).strict(),
    riskLevel: "read-only",
    egress: false,
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
      "Report how much of the context window is in use. Call it only when the user asks about context usage.",
    parameters: z.object({}),
    riskLevel: "read-only",
    egress: false,
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

/**
 * One page of a retrieved body: the widest budget the conversation gives a text result, less
 * room for the line saying where the next page starts.
 */
export const RETRIEVE_PAGE_CHARS = VERY_WIDE_PAYLOAD_MAX_CHARS - 1_000;

const retrieveToolResultParameters = z
  .object({
    tool_call_id: z.string().min(1).describe("From the offloaded placeholder or the cut result."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Character to start reading from, default 0; the previous page names the next one.",
      ),
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
      "Read back a tool result that was offloaded from context or cut to fit it, a page at a time. If nothing is stored, rerun the original tool.",
    parameters: retrieveToolResultParameters,
    riskLevel: "read-only",
    egress: false,
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

        const untrusted = yield* readOffloadedToolResultProvenance(
          context.agentId,
          conversationId,
          args.tool_call_id,
          contents,
        );
        const provenance = untrusted !== undefined ? { untrusted } : {};
        const offset = args.offset ?? 0;
        if (offset === 0 && contents.length <= RETRIEVE_PAGE_CHARS) {
          return { success: true, result: contents, ...provenance } satisfies ToolExecutionResult;
        }
        if (offset >= contents.length) {
          return {
            success: false,
            result: null,
            error: `offset ${String(offset)} is past the end of this ${String(contents.length)}-char result.`,
          } satisfies ToolExecutionResult;
        }
        const end = Math.min(offset + RETRIEVE_PAGE_CHARS, contents.length);
        const position = `[chars ${String(offset)}–${String(end)} of ${String(contents.length)}`;
        const footer =
          end < contents.length
            ? `${position}. Call retrieve_tool_result with offset ${String(end)} for the next page.]`
            : `${position}; this is the end.]`;
        return {
          success: true,
          result: `${contents.slice(offset, end)}\n${footer}`,
          ...provenance,
        } satisfies ToolExecutionResult;
      }),
  });
}
