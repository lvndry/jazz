/** Turns an empty model finish into a retryable failure, shared by the streaming and batch executors. */

import { Effect } from "effect";
import { isRetryableEmptyCompletion } from "@/core/agent/run/answer-outcome";
import type { LoggerService } from "@/core/interfaces/logger";
import type { ChatCompletionResponse } from "@/core/types/chat";
import { LLMRequestError } from "@/core/types/errors";
import { recordLLMUsage, type AgentRunMetrics } from "../metrics/agent-run-metrics";

export interface EmptyCompletionContext {
  readonly provider: string;
  readonly model: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly logger: LoggerService;
  readonly runMetrics: AgentRunMetrics;
}

/**
 * Passes `result` through unless its completion is an empty finish worth asking again. An empty
 * finish bills no output, so it joins the transient failures the shared retry budget already
 * covers, under its own reason. The rejected response never reaches the agent loop, so its
 * request and the usage it reported are recorded here.
 */
export function rejectEmptyCompletion<Result extends { completion: ChatCompletionResponse }>(
  result: Result,
  context: EmptyCompletionContext,
): Effect.Effect<Result, LLMRequestError> {
  return Effect.gen(function* () {
    const { completion } = result;
    if (!isRetryableEmptyCompletion(completion)) {
      return result;
    }
    context.runMetrics.totalRequests += 1;
    if (completion.usage) {
      recordLLMUsage(context.runMetrics, completion.usage);
    }
    yield* context.logger.warn("Model returned an empty response, retrying", {
      reason: "empty_response",
      provider: context.provider,
      model: context.model,
      finishReason: completion.finishReason ?? "none",
      completionTokens: completion.usage?.completionTokens ?? 0,
      promptTokens: completion.usage?.promptTokens ?? 0,
      agentId: context.agentId,
      conversationId: context.conversationId,
    });
    return yield* Effect.fail(
      new LLMRequestError({
        provider: context.provider,
        message: "The model returned an empty response (no text and no tool calls).",
        emptyResponse: true,
      }),
    );
  });
}
