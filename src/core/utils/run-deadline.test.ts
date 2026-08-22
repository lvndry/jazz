import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createRunDeadline } from "./run-deadline";

describe("createRunDeadline", () => {
  it("fails watch once the timeout elapses", async () => {
    const deadline = createRunDeadline(50);
    await expect(Effect.runPromise(deadline.watch)).rejects.toThrow(/50ms timeout/);
  });

  it("does not fire before the timeout elapses", async () => {
    const deadline = createRunDeadline(500);
    const result = await Effect.runPromise(
      Effect.race(deadline.watch, Effect.succeed("done").pipe(Effect.delay(50))),
    );
    expect(result).toBe("done");
  });

  it("extend() pushes the deadline out so a pending watch does not fire early", async () => {
    const deadline = createRunDeadline(100);
    // Simulate an approval wait starting right away: push the deadline out
    // far enough that the original 100ms budget would have already expired.
    deadline.extend(400);
    const result = await Effect.runPromise(
      Effect.race(
        deadline.watch,
        Effect.succeed("resolved-before-original-deadline").pipe(Effect.delay(200)),
      ),
    );
    expect(result).toBe("resolved-before-original-deadline");
  });

  it("extend() never shortens an already-later deadline", async () => {
    const deadline = createRunDeadline(500);
    // A shorter extend() than the remaining budget must not bring the
    // deadline closer — only ever push it further out.
    deadline.extend(50);
    const result = await Effect.runPromise(
      Effect.race(deadline.watch, Effect.succeed("done").pipe(Effect.delay(200))),
    );
    expect(result).toBe("done");
  });
});
