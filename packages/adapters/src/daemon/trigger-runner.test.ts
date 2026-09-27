import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
import type { ClaimedWorkflowRun } from "@jazz/core/workflows/catch-up";
import { describe, expect, it } from "bun:test";
import { Deferred, Effect } from "effect";
import { runTick, type TickWork, wakeTriggerTurnPrompt } from "./trigger-runner";

const reminder: ReminderRecord = { id: "r1", fireAt: 0, text: "stretch", createdAt: 0 };

const slowWorkflowClaim = {
  record: { id: "slow-run" },
} as unknown as ClaimedWorkflowRun;

function tickWork(overrides: Partial<TickWork<never>>): TickWork<never> {
  return {
    claimWorkflows: Effect.succeed([]),
    runWorkflow: () => Effect.void,
    claimWakeTriggers: () => Effect.succeed([]),
    deliverWakeTrigger: () => Effect.void,
    claimReminders: () => Effect.succeed([]),
    deliverReminder: () => Effect.void,
    drainDetachedJobs: Effect.void,
    drainJobBatches: Effect.void,
    ...overrides,
  };
}

describe("runTick", () => {
  /** The regression: the tick awaited each workflow, so a 30-minute workflow held every reminder. */
  it("delivers a reminder while a slow workflow from the same tick is still running", async () => {
    const program = Effect.gen(function* () {
      const workflowStarted = yield* Deferred.make<void>();
      const workflowReleased = yield* Deferred.make<void>();
      const reminderDelivered = yield* Deferred.make<string>();
      const work = tickWork({
        claimWorkflows: Effect.succeed([slowWorkflowClaim]),
        runWorkflow: () =>
          Deferred.succeed(workflowStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(workflowReleased)),
          ),
        claimReminders: () => Effect.succeed([{ agentId: "agent-1", item: reminder }]),
        deliverReminder: (_agentId, delivered) =>
          Deferred.succeed(reminderDelivered, delivered.text).pipe(Effect.asVoid),
      });

      yield* runTick({ runWorkflows: true }, work);
      yield* Deferred.await(workflowStarted);
      const text = yield* Deferred.await(reminderDelivered);
      const workflowStillRunning = !(yield* Deferred.isDone(workflowReleased));
      yield* Deferred.succeed(workflowReleased, undefined);
      return { text, workflowStillRunning };
    });

    const result = await Effect.runPromise(program.pipe(Effect.timeout("2 seconds")));
    expect(result).toEqual({ text: "stretch", workflowStillRunning: true });
  });

  it("starts a long drain once, however many ticks come while it runs", async () => {
    let drains = 0;
    const program = Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const work = tickWork({
        drainJobBatches: Effect.sync(() => {
          drains += 1;
        }).pipe(Effect.zipRight(Deferred.await(released))),
      });
      yield* runTick({}, work);
      yield* runTick({}, work);
      yield* runTick({}, work);
      yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(released, undefined);
    });
    await Effect.runPromise(program);
    expect(drains).toBe(1);
  });
});

describe("wakeTriggerTurnPrompt", () => {
  const fireAt = Date.UTC(2026, 8, 27, 9, 0);

  it("says when a trigger fires on time", () => {
    expect(wakeTriggerTurnPrompt({ fireAt, prompt: "leave now" }, fireAt + 30_000)).toBe(
      "[Wake trigger scheduled for 2026-09-27T09:00:00.000Z, firing at 2026-09-27T09:00:30.000Z (on time).]\n\nleave now",
    );
  });

  /** After a laptop sleeps, a 09:00 trigger that fires at 18:00 must not read as on time. */
  it("says how late a trigger fires", () => {
    const prompt = wakeTriggerTurnPrompt({ fireAt, prompt: "leave now" }, fireAt + 9 * 3_600_000);
    expect(prompt).toContain("scheduled for 2026-09-27T09:00:00.000Z");
    expect(prompt).toContain("(9 hours late)");
  });
});
