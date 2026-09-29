/** User-visible retry scheduling and slow-response notices for LLM calls. */

import { Duration, Effect, Fiber, Ref, Schedule } from "effect";
import { LLM_SLOW_MODEL_HINT_SECONDS } from "@/core/constants/agent";
import type { LlmRetryNotice } from "@/core/interfaces/presentation";
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
  presentRetry?: (notice: LlmRetryNotice) => Effect.Effect<void, never>,
) {
  return llmRetryDelays().pipe(
    Schedule.checkEffect(() =>
      Effect.gen(function* () {
        const attemptsUsed = yield* Ref.get(attemptRef);
        if (attemptsUsed >= maxRetries) {
          return false;
        }
        yield* Ref.set(attemptRef, attemptsUsed + 1);
        return true;
      }),
    ),
    // Announced here rather than in the check: only this stage sees the final delay, after
    // jitter and any Retry-After, so the wait it names is the wait that happens.
    Schedule.modifyDelayEffect(([, error], delay) =>
      Effect.gen(function* () {
        const notice = retryNotice(agentName, error, yield* Ref.get(attemptRef), maxRetries, delay);
        if (presentRetry === undefined) {
          yield* presentStatus(retryNoticeText(notice), "progress");
        } else {
          yield* presentRetry(notice);
        }
        return delay;
      }),
    ),
  );
}

function retryNotice(
  agentName: string,
  error: unknown,
  attempt: number,
  maxAttempts: number,
  delay: Duration.Duration,
): LlmRetryNotice {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const provider = typeof record["provider"] === "string" ? record["provider"] : undefined;
  const statusCode = typeof record["statusCode"] === "number" ? record["statusCode"] : undefined;
  return {
    agentName,
    ...(provider === undefined ? {} : { provider }),
    reason: describeRetryableLLMError(error),
    detail: retryNoticeDetail(error),
    ...(statusCode === undefined ? {} : { statusCode }),
    attempt,
    maxAttempts,
    retryInMs: Duration.toMillis(delay),
  };
}

/** The retry notice as one line, for surfaces without a structured retry display. */
export function retryNoticeText(notice: LlmRetryNotice): string {
  const seconds = Math.max(1, Math.round(notice.retryInMs / 1000));
  const detail = notice.detail ? ` (${notice.detail})` : "";
  return `${notice.agentName} hit a ${notice.reason}${detail}. Trying again in ${String(seconds)}s (attempt ${String(notice.attempt)} of up to ${String(notice.maxAttempts)})…`;
}
