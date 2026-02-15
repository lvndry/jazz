import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";

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
    description:
      "Get current date and time. Use for scheduling, relative times (yesterday, next Monday), and timestamps.",
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
    description: "Get current context window token usage statistics.",
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
