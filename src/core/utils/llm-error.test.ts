import { describe, expect, it } from "bun:test";
import { Effect, Ref } from "effect";
import { LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import { isRetryableLLMError, makeLLMRetrySchedule } from "./llm-error";

const instantClock = {
  currentTimeMillis: Effect.succeed(0),
  currentTimeNanos: Effect.succeed(BigInt(0)),
  sleep: (_duration: unknown) => Effect.void,
};

function withInstantClock<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.withClock(instantClock)(effect);
}

function countRetryAttempts(schedule: ReturnType<typeof makeLLMRetrySchedule>, error: unknown) {
  return withInstantClock(
    Effect.gen(function* () {
      const countRef = yield* Ref.make(0);
      yield* Effect.retry(
        Effect.gen(function* () {
          yield* Ref.update(countRef, (count) => count + 1);
          return yield* Effect.fail(error);
        }),
        schedule,
      ).pipe(Effect.catchAll(() => Effect.void));
      const total = yield* Ref.get(countRef);
      return total - 1;
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.catchAll(() => Effect.succeed(-1)),
    ),
  );
}

const retryableError = new LLMRateLimitError({ message: "rate limited", provider: "openai" });
const nonRetryableError = new LLMRequestError({ message: "bad request", statusCode: 400 });

describe("isRetryableLLMError", () => {
  it("returns true for LLMRateLimitError", () => {
    expect(isRetryableLLMError(retryableError)).toBe(true);
  });

  it("returns false for non-retryable LLMRequestError (4xx)", () => {
    expect(isRetryableLLMError(nonRetryableError)).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isRetryableLLMError(new Error("generic"))).toBe(false);
  });
});

describe("makeLLMRetrySchedule", () => {
  it("bounded mode: retries exactly maxRetries times on retryable error", async () => {
    const maxRetries = 3;
    const schedule = makeLLMRetrySchedule(maxRetries, false);
    const retryCount = await Effect.runPromise(countRetryAttempts(schedule, retryableError));
    expect(retryCount).toBe(maxRetries);
  });

  it("bounded mode: does not retry on non-retryable error", async () => {
    const schedule = makeLLMRetrySchedule(5, false);
    const retryCount = await Effect.runPromise(countRetryAttempts(schedule, nonRetryableError));
    expect(retryCount).toBe(0);
  });

  it("unlimited mode: retries more than maxRetries times on retryable error", async () => {
    const maxRetries = 3;
    const extraRetries = maxRetries + 5;
    const schedule = makeLLMRetrySchedule(maxRetries, true);
    const retryCount = await Effect.runPromise(
      withInstantClock(
        Effect.gen(function* () {
          const countRef = yield* Ref.make(0);
          yield* Effect.retry(
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(countRef, (n) => n + 1);
              if (count > extraRetries) return yield* Effect.void;
              return yield* Effect.fail(retryableError);
            }),
            schedule,
          ).pipe(Effect.catchAll(() => Effect.void));
          const total = yield* Ref.get(countRef);
          return total - 1;
        }),
      ),
    );
    expect(retryCount).toBe(extraRetries);
  });

  it("unlimited mode: still does not retry on non-retryable error", async () => {
    const schedule = makeLLMRetrySchedule(5, true);
    const retryCount = await Effect.runPromise(countRetryAttempts(schedule, nonRetryableError));
    expect(retryCount).toBe(0);
  });

  it("default second parameter behaves as bounded", async () => {
    const maxRetries = 2;
    const schedule = makeLLMRetrySchedule(maxRetries);
    const retryCount = await Effect.runPromise(countRetryAttempts(schedule, retryableError));
    expect(retryCount).toBe(maxRetries);
  });
});
