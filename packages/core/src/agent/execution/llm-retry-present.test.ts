import { describe, expect, it } from "bun:test";
import { Effect, Ref } from "effect";
import type { LlmRetryNotice } from "@/core/interfaces/presentation";
import { LLMRequestError } from "@/core/types/errors";
import { makeUserVisibleLlmRetrySchedule } from "./llm-retry-present";

/**
 * The retry notice is the only thing the user sees while an agent is stalled, so it has to
 * describe what is actually about to happen.
 */
function collectNotices(maxRetries: number, error: unknown) {
  return Effect.gen(function* () {
    const notices: string[] = [];
    const attemptRef = yield* Ref.make(0);
    const schedule = makeUserVisibleLlmRetrySchedule(
      maxRetries,
      "agent",
      (message) => {
        notices.push(message);
        return Effect.void;
      },
      attemptRef,
    );

    // Always-failing effect, so the schedule runs to exhaustion.
    yield* Effect.fail(error).pipe(
      Effect.retry(schedule),
      Effect.catchAll(() => Effect.void),
    );
    return notices;
  });
}

describe("makeUserVisibleLlmRetrySchedule", () => {
  // Retry counts stay at 2 throughout: the schedule uses real exponential backoff, so each
  // extra retry adds seconds of wall-clock to the suite for no extra coverage.
  it("never announces more attempts than it will make", async () => {
    // The schedule also receives the failure that exhausts it, so the counter reached
    // maxRetries + 1 and printed "attempt 11 of up to 10" — promising a retry that never came.
    const transient = new LLMRequestError({ provider: "ollama", message: "fetch failed" });
    const notices = await Effect.runPromise(collectNotices(2, transient));

    expect(notices.length).toBeLessThanOrEqual(2);
    expect(notices.join(" ")).not.toContain("attempt 3 of up to 2");
  }, 20_000);

  it("says nothing at all for a request the provider rejected outright", async () => {
    const permanent = new LLMRequestError({
      provider: "ollama",
      message: "'file part media type audio/ogg' functionality not supported.",
      permanent: true,
    });
    expect(await Effect.runPromise(collectNotices(2, permanent))).toEqual([]);
  }, 20_000);

  it("still reports a genuine transient failure", async () => {
    const transient = new LLMRequestError({ provider: "ollama", message: "fetch failed" });
    const notices = await Effect.runPromise(collectNotices(2, transient));

    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toContain("network issue");
    expect(notices[0]).toContain("attempt 1 of up to 2");
  }, 20_000);

  it("names the underlying error, not just its category", async () => {
    const transient = new LLMRequestError({
      provider: "chatgpt",
      message: "Unsupported provider\n    at selectModel (ai-sdk-service.ts:1043)",
    });
    const notices = await Effect.runPromise(collectNotices(1, transient));

    expect(notices[0]).toContain("network issue (Unsupported provider)");
    expect(notices[0]).not.toContain("selectModel");
  }, 20_000);

  it("names the real wait in the prose notice", async () => {
    const transient = new LLMRequestError({ provider: "ollama", message: "fetch failed" });
    const notices = await Effect.runPromise(collectNotices(1, transient));
    expect(notices[0]).toMatch(/Trying again in \d+s \(attempt 1 of up to 1\)/);
  }, 20_000);

  it("hands a structured notice, with the scheduled delay, to a surface that shows retries", async () => {
    const transient = new LLMRequestError({
      provider: "openai",
      message: "Service Unavailable",
      statusCode: 503,
    });
    const program = Effect.gen(function* () {
      const structured: LlmRetryNotice[] = [];
      const prose: string[] = [];
      const attemptRef = yield* Ref.make(0);
      const schedule = makeUserVisibleLlmRetrySchedule(
        1,
        "agent",
        (message) => {
          prose.push(message);
          return Effect.void;
        },
        attemptRef,
        (notice) => {
          structured.push(notice);
          return Effect.void;
        },
      );
      yield* Effect.fail(transient).pipe(
        Effect.retry(schedule),
        Effect.catchAll(() => Effect.void),
      );
      return { structured, prose };
    });
    const { structured, prose } = await Effect.runPromise(program);

    expect(prose).toEqual([]);
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({
      agentName: "agent",
      provider: "openai",
      statusCode: 503,
      reason: "server error (503)",
      attempt: 1,
      maxAttempts: 1,
    });
    expect(structured[0]?.retryInMs).toBeGreaterThan(0);
  }, 20_000);
});
