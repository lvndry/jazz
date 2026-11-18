import { Duration, Effect } from "effect";
import { LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import { TimeoutError } from "@/core/types/errors";

const MODEL_STEP_TIMEOUT_MS = LLM_TIMEOUT_SECONDS * 1000;

function withLlmTimeout(
  operation: string,
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TimeoutError, R> {
  return (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(LLM_TIMEOUT_SECONDS),
        orElse: () =>
          Effect.fail(
            new TimeoutError({
              operation,
              timeout: MODEL_STEP_TIMEOUT_MS,
              suggestion: "Check connectivity to the model provider, or try again.",
            }),
          ),
      }),
    );
}

/**
 * Bound one non-streaming model step, retries included, to `LLM_TIMEOUT_SECONDS`, failing with
 * Jazz's `TimeoutError` that names the agent and the limit. A request that does not stream sends
 * nothing until it is done, so this limit is the only thing that ends one the server never
 * answers.
 *
 * `Effect.timeout` fails with Effect's own `TimeoutError`, whose tag is also "TimeoutError" but
 * which carries no operation or duration, so the error handler printed
 * `Operation "undefined" timed out after undefinedms`.
 */
export function withModelStepTimeout(
  agentName: string,
): <A, E, R>(step: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TimeoutError, R> {
  return withLlmTimeout(`${agentName}'s model step (including retries)`);
}

/**
 * Bound one non-streaming fallback attempt inside a streaming step. Streaming attempts need no
 * wall-clock limit: the stream idle timeout ends one that goes silent, so a model that keeps
 * producing output is never cut off however long it reasons.
 */
export function withNonStreamingAttemptTimeout(
  agentName: string,
): <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TimeoutError, R> {
  return withLlmTimeout(`${agentName}'s non-streaming model request`);
}
