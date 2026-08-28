import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  MAX_WAKE_TRIGGERS_PER_AGENT,
  WAKE_TRIGGER_PROMPT_MAX_LENGTH,
} from "@jazz/core/constants/wake-triggers";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { WakeTriggerServiceImpl, sweepDueWakeTriggers } from "./wake-trigger-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-wake-trigger-test-"));
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

function makeService(): WakeTriggerServiceImpl {
  return new WakeTriggerServiceImpl({ baseWakeTriggerDirectory: tmpDir });
}

describe("add", () => {
  test("adds a wake trigger parsed from a duration, carrying the conversation to resume", async () => {
    const service = makeService();
    const now = Date.now();
    const outcome = await runEffect(
      service.add("agent-1", "conv-1", "30m", "check the build", "wants to check on it", "UTC"),
    );
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.trigger.conversationId).toBe("conv-1");
      expect(outcome.trigger.prompt).toBe("check the build");
      expect(outcome.trigger.fireAt).toBeGreaterThan(now);
      expect(outcome.trigger.id.length).toBeGreaterThan(0);
    }
  });

  test("returns a clear failure message for an unparseable 'when', not a thrown error", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.add("agent-1", "conv-1", "next friday sometime", "prompt", "reason", "UTC"),
    );
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.message).toContain("next friday sometime");
    }
  });

  test("rejects once the per-agent pending trigger cap is reached", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_WAKE_TRIGGERS_PER_AGENT; i++) {
      const outcome = await runEffect(
        service.add("agent-1", "conv-1", "1d", `prompt ${i}`, "reason", "UTC"),
      );
      expect(outcome.success).toBe(true);
    }
    const result = await runEither(
      service.add("agent-1", "conv-1", "1d", "one too many", "reason", "UTC"),
    );
    expect(result._tag).toBe("Left");
  }, 30_000);

  test("rejects a prompt exceeding the max length", async () => {
    const service = makeService();
    const tooLong = "x".repeat(WAKE_TRIGGER_PROMPT_MAX_LENGTH + 1);
    const result = await runEither(
      service.add("agent-1", "conv-1", "30m", tooLong, "reason", "UTC"),
    );
    expect(result._tag).toBe("Left");
  });

  test("rejects a fire time already in the past", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.add("agent-1", "conv-1", "2020-01-01 09:00", "prompt", "reason", "UTC"),
    );
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.message).toContain("in the past");
    }
  });
});

describe("list", () => {
  test("returns an empty list for a fresh agent", async () => {
    const service = makeService();
    const list = await runEffect(service.list("agent-1"));
    expect(list).toEqual([]);
  });

  test("keeps different agents' triggers separate", async () => {
    const service = makeService();
    await runEffect(service.add("agent-1", "conv-1", "30m", "for agent 1", "reason", "UTC"));
    await runEffect(service.add("agent-2", "conv-2", "30m", "for agent 2", "reason", "UTC"));
    const listOne = await runEffect(service.list("agent-1"));
    const listTwo = await runEffect(service.list("agent-2"));
    expect(listOne.map((t) => t.prompt)).toEqual(["for agent 1"]);
    expect(listTwo.map((t) => t.prompt)).toEqual(["for agent 2"]);
  });
});

describe("cancel", () => {
  test("cancels an existing trigger", async () => {
    const service = makeService();
    const added = await runEffect(
      service.add("agent-1", "conv-1", "30m", "cancel me", "reason", "UTC"),
    );
    expect(added.success).toBe(true);
    if (!added.success) return;

    const outcome = await runEffect(service.cancel("agent-1", added.trigger.id));
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

describe("sweepDueWakeTriggers", () => {
  test("removes only due triggers, leaving future ones in place, across multiple agent files", async () => {
    const service = makeService();
    const now = Date.now();

    const due1 = await runEffect(
      service.add("agent-1", "conv-1", "1s", "due soon agent 1", "reason", "UTC"),
    );
    const future1 = await runEffect(
      service.add("agent-1", "conv-1", "1d", "future agent 1", "reason", "UTC"),
    );
    const due2 = await runEffect(
      service.add("agent-2", "conv-2", "1s", "due soon agent 2", "reason", "UTC"),
    );

    expect(due1.success && future1.success && due2.success).toBe(true);

    const sweepAt = now + 5_000;
    const fired = await runEffect(sweepDueWakeTriggers(tmpDir, sweepAt));

    const firedByAgent = new Map(fired.map((f) => [f.agentId, f.trigger.prompt]));
    expect(firedByAgent.get("agent-1")).toBe("due soon agent 1");
    expect(firedByAgent.get("agent-2")).toBe("due soon agent 2");
    expect(fired.length).toBe(2);

    const remainingAgent1 = await runEffect(service.list("agent-1"));
    expect(remainingAgent1.map((t) => t.prompt)).toEqual(["future agent 1"]);

    const remainingAgent2 = await runEffect(service.list("agent-2"));
    expect(remainingAgent2).toEqual([]);
  });

  test("returns an empty array when the wake-triggers directory does not exist yet", async () => {
    const emptyDir = path.join(tmpDir, "does-not-exist");
    const fired = await runEffect(sweepDueWakeTriggers(emptyDir, Date.now()));
    expect(fired).toEqual([]);
  });

  test("does not fire triggers that aren't due yet", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.add("agent-1", "conv-1", "1d", "not yet", "reason", "UTC"),
    );
    expect(outcome.success).toBe(true);

    const fired = await runEffect(sweepDueWakeTriggers(tmpDir, Date.now()));
    expect(fired).toEqual([]);

    const list = await runEffect(service.list("agent-1"));
    expect(list.length).toBe(1);
  });
});
