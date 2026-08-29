import { describe, test, expect, afterEach } from "bun:test";
import { Effect } from "effect";
import { createReminderOsScheduler } from "./reminder-os-scheduler";

const originalSchedulerEnv = process.env["JAZZ_SCHEDULER"];

afterEach(() => {
  if (originalSchedulerEnv === undefined) {
    delete process.env["JAZZ_SCHEDULER"];
  } else {
    process.env["JAZZ_SCHEDULER"] = originalSchedulerEnv;
  }
});

describe("createReminderOsScheduler", () => {
  test("respects JAZZ_SCHEDULER=in-process regardless of platform", async () => {
    process.env["JAZZ_SCHEDULER"] = "in-process";
    const scheduler = await Effect.runPromise(createReminderOsScheduler());
    expect(scheduler.getType()).toBe("in-process");
  });

  test("in-process scheduler never fails scheduleFire/cancelFire", async () => {
    process.env["JAZZ_SCHEDULER"] = "in-process";
    const scheduler = await Effect.runPromise(createReminderOsScheduler());
    const result = await Effect.runPromise(
      scheduler.scheduleFire("agent-1", "reminder-1", Date.now()),
    );
    expect(result).toEqual({});
    await Effect.runPromise(scheduler.cancelFire("agent-1", "reminder-1", undefined));
  });

  test("selects a scheduler type matching a supported platform when not forced in-process", async () => {
    delete process.env["JAZZ_SCHEDULER"];
    const scheduler = await Effect.runPromise(createReminderOsScheduler());
    expect(["launchd", "at", "in-process", "unsupported"]).toContain(scheduler.getType());
  });
});
