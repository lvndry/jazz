import { Duration, Effect, Fiber, Ref, Schedule } from "effect";
import { LLM_SLOW_MODEL_HINT_SECONDS } from "@/core/constants/agent";
import { isRetryableLLMError, makeLLMRetrySchedule } from "@/core/utils/llm-error";

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
    return yield* body.pipe(
      Effect.ensuring(Fiber.interrupt(noticeFiber).pipe(Effect.catchAll(() => Effect.void))),
    );
  });
}

export function makeUserVisibleLlmRetrySchedule(
  maxRetries: number,
  agentName: string,
  presentStatus: PresentStatusFn,
  attemptRef: Ref.Ref<number>,
) {
  return makeLLMRetrySchedule(maxRetries).pipe(
    Schedule.tapInput((error: unknown) =>
      isRetryableLLMError(error)
        ? Effect.gen(function* () {
            yield* Ref.update(attemptRef, (count) => count + 1);
            const attempt = yield* Ref.get(attemptRef);
            yield* presentStatus(
              `${agentName} hit a temporary network or model issue. Trying again (attempt ${attempt} of up to ${maxRetries})…`,
              "progress",
            );
          })
        : Effect.void,
    ),
  );
}
