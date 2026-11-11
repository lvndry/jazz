import { describe, expect, it } from "bun:test";
import { Duration, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import { formatError } from "@/core/presentation/error-handler";
import { TimeoutError } from "@/core/types/errors";
import { withModelStepTimeout } from "./model-step-timeout";

describe("withModelStepTimeout", () => {
  it("fails a step past the limit with a TimeoutError naming the agent and the limit", async () => {
    const exit = await Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(
        withModelStepTimeout("ksyl-reviewer"),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(LLM_TIMEOUT_SECONDS));
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const failure = reason?._tag === "Fail" ? reason.error : undefined;
    if (!(failure instanceof TimeoutError)) {
      throw new Error(`expected a TimeoutError, got ${String(failure)}`);
    }
    expect(formatError(failure)).toContain(
      `"ksyl-reviewer's model step (including retries)" timed out after 15m`,
    );
  });

  it("leaves a step that finishes in time alone", async () => {
    const result = await Effect.succeed("answer").pipe(
      withModelStepTimeout("ksyl-reviewer"),
      Effect.runPromise,
    );

    expect(result).toBe("answer");
  });
});
