/** Turns an empty model finish into a retryable failure, shared by the streaming and batch executors. */

import { Effect } from "effect";
import { isRetryableEmptyCompletion } from "@/core/agent/run/answer-outcome";
import type { LoggerService } from "@/core/interfaces/logger";
import type { ChatCompletionResponse } from "@/core/types/chat";
import { LLMRequestError } from "@/core/types/errors";

export interface EmptyCompletionContext {
  readonly provider: string;
  readonly model: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly logger: LoggerService;
  /**
   * Called with the rejected completion before the failure, so the caller can attribute the
   * usage it reported to the failed attempt.
   */
  readonly onRejected?: (completion: ChatCompletionResponse) => Effect.Effect<void>;
}

/**
 * Passes `result` through unless its completion is an empty finish worth asking again. An empty
 * finish bills no output, so it joins the transient failures the shared retry budget already
 * covers, under its own reason. The rejected response never reaches the agent loop, and the
 * usage it reported is not added to the run's own totals: the caller's failed-attempt record
 * owns it, through `onRejected`.
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
    if (context.onRejected !== undefined) {
      yield* context.onRejected(completion);
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
