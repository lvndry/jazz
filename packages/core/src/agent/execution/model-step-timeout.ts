import { Duration, Effect } from "effect";
import { LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import { TimeoutError } from "@/core/types/errors";

const MODEL_STEP_TIMEOUT_MS = LLM_TIMEOUT_SECONDS * 1000;

/**
 * Bound one model step, retries included, to `LLM_TIMEOUT_SECONDS`, failing with Jazz's
 * `TimeoutError` that names the agent and the limit.
 *
 * `Effect.timeout` fails with Effect's own `TimeoutError`, whose tag is also "TimeoutError" but
 * which carries no operation or duration, so the error handler printed
 * `Operation "undefined" timed out after undefinedms`.
 */
export function withModelStepTimeout(
  agentName: string,
): <A, E, R>(step: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TimeoutError, R> {
  return (step) =>
    step.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(LLM_TIMEOUT_SECONDS),
        orElse: () =>
          Effect.fail(
            new TimeoutError({
              operation: `${agentName}'s model step (including retries)`,
              timeout: MODEL_STEP_TIMEOUT_MS,
              suggestion: "Check connectivity to the model provider, or try again.",
            }),
          ),
      }),
    );
}
