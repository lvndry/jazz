import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { MAX_REMINDERS_PER_AGENT, REMINDER_TEXT_MAX_LENGTH } from "@/core/constants/reminders";
import { ReminderServiceImpl, sweepDueReminders } from "./reminder-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-reminder-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function runEither<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return runEffect(eff.pipe(Effect.either));
}

function makeService(): ReminderServiceImpl {
  return new ReminderServiceImpl({ baseReminderDirectory: tmpDir });
}

describe("add", () => {
  test("adds a reminder parsed from a duration", async () => {
    const service = makeService();
    const now = Date.now();
    const outcome = await runEffect(service.add("agent-1", "30m", "call the plumber", "UTC"));
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.reminder.text).toBe("call the plumber");
      expect(outcome.reminder.fireAt).toBeGreaterThan(now);
      expect(outcome.reminder.id.length).toBeGreaterThan(0);
    }
  });

  test("succeeds on a fresh deployment where the base reminder directory does not exist yet", async () => {
    // Regression: on a real fresh deploy (or an agent's first-ever reminder),
    // ~/.jazz/reminders/ has never been created. The lock is a directory made
    // with recursive:false, so if nothing creates the parent first, every
    // makeDirectory attempt inside acquireLock fails with ENOENT and the whole
    // call surfaces as a false "failed to acquire lock after retries" — tests
    // using mkdtempSync never caught this because mkdtempSync always
    // pre-creates the directory.
    const freshDir = path.join(tmpDir, "not-created-yet");
    const service = new ReminderServiceImpl({ baseReminderDirectory: freshDir });
    const outcome = await runEffect(service.add("agent-1", "30m", "call the plumber", "UTC"));
    expect(outcome.success).toBe(true);
  });

  test("returns a clear failure message for an unparseable 'when', not a thrown error", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.add("agent-1", "next friday sometime", "water the plants", "UTC"),
    );
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.message).toContain("next friday sometime");
    }
  });

  test("rejects once the per-agent reminder count cap is reached", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_REMINDERS_PER_AGENT; i++) {
      const outcome = await runEffect(service.add("agent-1", "1d", `reminder ${i}`, "UTC"));
      expect(outcome.success).toBe(true);
    }
    const result = await runEither(service.add("agent-1", "1d", "one too many", "UTC"));
    expect(result._tag).toBe("Left");
  }, 30_000);

  test("rejects text exceeding the max length", async () => {
    const service = makeService();
    const tooLong = "x".repeat(REMINDER_TEXT_MAX_LENGTH + 1);
    const result = await runEither(service.add("agent-1", "30m", tooLong, "UTC"));
    expect(result._tag).toBe("Left");
  });

  test("two near-simultaneous adds both land without corrupting the file", async () => {
    const service = makeService();
    const [first, second] = await Promise.all([
      runEffect(service.add("agent-1", "10m", "first", "UTC")),
      runEffect(service.add("agent-1", "20m", "second", "UTC")),
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const list = await runEffect(service.list("agent-1"));
    expect(list.length).toBe(2);
    expect(list.map((r) => r.text).sort()).toEqual(["first", "second"]);
  });
});

describe("list", () => {
  test("returns an empty list for a fresh agent", async () => {
    const service = makeService();
    const list = await runEffect(service.list("agent-1"));
    expect(list).toEqual([]);
  });

  test("returns reminders added for that agent", async () => {
    const service = makeService();
    await runEffect(service.add("agent-1", "30m", "one", "UTC"));
    await runEffect(service.add("agent-1", "1h", "two", "UTC"));
    const list = await runEffect(service.list("agent-1"));
    expect(list.length).toBe(2);
  });

  test("keeps different agents' reminders separate", async () => {
    const service = makeService();
    await runEffect(service.add("agent-1", "30m", "for agent 1", "UTC"));
    await runEffect(service.add("agent-2", "30m", "for agent 2", "UTC"));
    const listOne = await runEffect(service.list("agent-1"));
    const listTwo = await runEffect(service.list("agent-2"));
    expect(listOne.map((r) => r.text)).toEqual(["for agent 1"]);
    expect(listTwo.map((r) => r.text)).toEqual(["for agent 2"]);
  });
});

describe("cancel", () => {
  test("cancels an existing reminder", async () => {
    const service = makeService();
    const added = await runEffect(service.add("agent-1", "30m", "cancel me", "UTC"));
    expect(added.success).toBe(true);
    if (!added.success) return;

    const outcome = await runEffect(service.cancel("agent-1", added.reminder.id));
    expect(outcome.success).toBe(true);
    const list = await runEffect(service.list("agent-1"));
    expect(list).toEqual([]);
  });

  test("fails for an unknown id", async () => {
    const service = makeService();
    const outcome = await runEffect(service.cancel("agent-1", "does-not-exist"));
    expect(outcome.success).toBe(false);
  });
});

describe("sweepDueReminders", () => {
  test("removes only due reminders, leaving future ones in place, across multiple agent files", async () => {
    const service = makeService();
    const now = Date.now();

    const due1 = await runEffect(service.add("agent-1", "1s", "due soon agent 1", "UTC"));
    const future1 = await runEffect(service.add("agent-1", "1d", "future agent 1", "UTC"));
    const due2 = await runEffect(service.add("agent-2", "1s", "due soon agent 2", "UTC"));

    expect(due1.success && future1.success && due2.success).toBe(true);

    // Sweep at a time after the "1s" reminders have come due but well before "1d".
    const sweepAt = now + 5_000;
    const fired = await runEffect(sweepDueReminders(tmpDir, sweepAt));

    const firedByAgent = new Map(fired.map((f) => [f.agentId, f.reminder.text]));
    expect(firedByAgent.get("agent-1")).toBe("due soon agent 1");
    expect(firedByAgent.get("agent-2")).toBe("due soon agent 2");
    expect(fired.length).toBe(2);

    const remainingAgent1 = await runEffect(service.list("agent-1"));
    expect(remainingAgent1.map((r) => r.text)).toEqual(["future agent 1"]);

    const remainingAgent2 = await runEffect(service.list("agent-2"));
    expect(remainingAgent2).toEqual([]);
  });

  test("returns an empty array when the reminders directory does not exist yet", async () => {
    const emptyDir = path.join(tmpDir, "does-not-exist");
    const fired = await runEffect(sweepDueReminders(emptyDir, Date.now()));
    expect(fired).toEqual([]);
  });

  test("does not fire reminders that aren't due yet", async () => {
    const service = makeService();
    const outcome = await runEffect(service.add("agent-1", "1d", "not yet", "UTC"));
    expect(outcome.success).toBe(true);

    const fired = await runEffect(sweepDueReminders(tmpDir, Date.now()));
    expect(fired).toEqual([]);

    const list = await runEffect(service.list("agent-1"));
    expect(list.length).toBe(1);
  });
});
