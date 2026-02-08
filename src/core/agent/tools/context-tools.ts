import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";

/**
 * Create the context_info tool for token budget awareness.
 * Allows agents to query current context window usage statistics.
 */
export function createContextInfoTool(): Tool<never> {
  return {
    name: "context_info",
    description:
      "Get current context window usage statistics. Use this to check remaining token budget before starting complex multi-step operations, or to decide whether to summarize previous context.",
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
