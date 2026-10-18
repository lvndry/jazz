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
await Bun.sleep(0);
Bun.gc(true);
await Bun.sleep(0);
Bun.gc(true);
assert.equal(answerRef.deref(), undefined, "the supervisor still retains a collected answer");
const reread = await Effect.runPromise(supervisor.wait([], "all", 5_000));
assert.equal(reread.subagents[0]?.status, "completed");
assert.equal(reread.subagents[0]?.alreadyRead, true);
await Effect.runPromise(supervisor.close());
