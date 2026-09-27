/** User-visible retry scheduling and slow-response notices for LLM calls. */

import { Duration, Effect, Fiber, Ref, Schedule } from "effect";
import { LLM_SLOW_MODEL_HINT_SECONDS } from "@/core/constants/agent";
import { describeRetryableLLMError, llmRetryDelays } from "@/core/utils/llm-error";

/** Keeps the retry notice on one terminal line while still naming the underlying failure. */
const RETRY_NOTICE_DETAIL_MAX_CHARS = 160;

function retryNoticeDetail(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= RETRY_NOTICE_DETAIL_MAX_CHARS) {
    return firstLine;
  }
  return `${firstLine.slice(0, RETRY_NOTICE_DETAIL_MAX_CHARS - 1)}…`;
}

export type PresentStatusFn = (
  message: string,
  level: "info" | "success" | "warning" | "error" | "progress",
) => Effect.Effect<void, never>;

export function withLongRunningLlmNotice<A, E, R>(
  agentName: string,
  presentStatus: PresentStatusFn,
  body: Effect.Effect<A, E, R>,
  slowHintAfterSeconds: number = LLM_SLOW_MODEL_HINT_SECONDS,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const noticeFiber = yield* Effect.fork(
      Effect.sleep(Duration.seconds(slowHintAfterSeconds)).pipe(
        Effect.flatMap(() =>
          presentStatus(
            `${agentName} is taking longer than expected… still waiting on the model.`,
            "progress",
          ),
        ),
      ),
    );
    return yield* body.pipe(Effect.ensuring(Fiber.interrupt(noticeFiber)));
  });
}

/**
 * The LLM retry schedule the user sees: `llmRetryDelays` plus a notice before each retry.
 *
 * The attempt budget lives in `attemptRef`, not in the schedule, so several schedules built on
 * the same ref (a streaming attempt and its non-streaming fallback) share one budget of
 * `maxRetries` retries instead of each getting a fresh one.
 */
export function makeUserVisibleLlmRetrySchedule(
  maxRetries: number,
  agentName: string,
  presentStatus: PresentStatusFn,
  attemptRef: Ref.Ref<number>,
) {
  return llmRetryDelays().pipe(
    Schedule.checkEffect((error: unknown) =>
      Effect.gen(function* () {
        const attemptsUsed = yield* Ref.get(attemptRef);
        if (attemptsUsed >= maxRetries) {
          return false;
        }
        const attempt = attemptsUsed + 1;
        yield* Ref.set(attemptRef, attempt);
        const reason = describeRetryableLLMError(error);
        const detail = retryNoticeDetail(error);
        yield* presentStatus(
          `${agentName} hit a ${reason}${detail ? ` (${detail})` : ""}. Trying again (attempt ${attempt} of up to ${maxRetries})…`,
          "progress",
        );
        return true;
      }),
    ),
  );
}
