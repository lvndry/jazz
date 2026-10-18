/**
 * Fresh-process retention check for the conversation supervisor. Keeping the supervisor alive
 * across collection must not keep a collected answer alive. A separate VM avoids conservative
 * stack roots left by unrelated, previously optimized tests in Bun's shared test process.
 */
import assert from "node:assert/strict";
import { Effect } from "effect";
import { createSubagentSupervisor } from "./supervisor";

const supervisor = await Effect.runPromise(createSubagentSupervisor({ outlivesRuns: true }));
supervisor.attachRun({ chargeSpend: () => {}, saveResult: (child) => `saved-${child.id}` });
const answerRef = await Effect.runPromise(
  Effect.gen(function* () {
    const answer = { report: "the whole report" };
    const child = supervisor.register({ name: "digest" });
    yield* supervisor.start(child.id, Effect.succeed({ success: true, result: answer }));
    const first = yield* supervisor.wait([], "all", 5_000);
    assert.equal(first.subagents[0]?.result, answer);
    return new WeakRef(answer);
  }),
);
/** GC may retain a weak target across early turns; allow a bounded number of distinct host tasks. */
async function awaitCollection(reference: WeakRef<object>): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    Bun.gc(true);
    if (reference.deref() === undefined) return;
  } while (Date.now() < deadline);
}

await awaitCollection(answerRef);
assert.equal(answerRef.deref(), undefined, "the supervisor still retains a collected answer");
const reread = await Effect.runPromise(supervisor.wait([], "all", 5_000));
assert.equal(reread.subagents[0]?.status, "completed");
assert.equal(reread.subagents[0]?.alreadyRead, true);
await Effect.runPromise(supervisor.close());
