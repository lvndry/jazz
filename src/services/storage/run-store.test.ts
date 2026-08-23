import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createRunRecord } from "@/core/agent/run/run-record";
import type { RunState } from "@/core/agent/run/run-state";
import type { RunStore } from "@/core/interfaces/run-store";
import { FileRunStore, InMemoryRunStore } from "./run-store";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const TRANSITION_AT = new Date("2026-08-23T11:30:00.000Z");
const OTHER_RUN_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

function record(runId: string, agentId = "agent-1", createdAt = new Date("2026-08-23T10:00:00Z")) {
  return createRunRecord({
    runId,
    agentId,
    conversationId: "conv-1",
    input: "summarize the last 5 commits",
    now: createdAt,
  });
}

function parkedState(expiresAt: string): RunState {
  return {
    kind: "input-required",
    pending: {
      kind: "tool-approval",
      request: {
        toolCallId: "call_1",
        toolName: "execute_command",
        message: "Run `git push`",
        executeToolName: "execute_command_execute",
        executeArgs: { command: "git push" },
      },
    },
    snapshot: { messages: [], iteration: 2 },
    expiresAt,
  };
}

function suite(name: string, makeStore: () => Promise<RunStore>, cleanup?: () => Promise<void>) {
  describe(name, () => {
    let store: RunStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it("round-trips a record", async () => {
      await Effect.runPromise(store.save(record(RUN_ID)));
      const loaded = await Effect.runPromise(store.get(RUN_ID));
      expect(loaded?.runId).toBe(RUN_ID);
      expect(loaded?.state.kind).toBe("submitted");
      expect(loaded?.input).toBe("summarize the last 5 commits");
    });

    it("returns undefined for a run it has never seen", async () => {
      expect(await Effect.runPromise(store.get(OTHER_RUN_ID))).toBeUndefined();
    });

    it("restamps updatedAt on transition and leaves createdAt alone", async () => {
      const original = record(RUN_ID);
      await Effect.runPromise(store.save(original));
      const updated = await Effect.runPromise(
        store.transition(RUN_ID, { kind: "working", iteration: 1 }),
      );
      expect(updated.state.kind).toBe("working");
      expect(updated.createdAt).toBe(original.createdAt);
      expect(updated.updatedAt).toBe(TRANSITION_AT.toISOString());
    });

    it("preserves a parked snapshot across a reload", async () => {
      await Effect.runPromise(store.save(record(RUN_ID)));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(store.transition(RUN_ID, parkedState("2026-08-24T10:00:00.000Z")));

      const loaded = await Effect.runPromise(store.get(RUN_ID));
      expect(loaded?.state.kind).toBe("input-required");
      if (loaded?.state.kind !== "input-required") throw new Error("expected a parked run");
      expect(loaded.state.pending.kind).toBe("tool-approval");
      if (loaded.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
      expect(loaded.state.pending.request.toolCallId).toBe("call_1");
      expect(loaded.state.snapshot.iteration).toBe(2);
    });

    it("refuses an illegal transition instead of writing it", async () => {
      await Effect.runPromise(store.save(record(RUN_ID)));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "completed", content: "done" }));

      const result = await Effect.runPromiseExit(
        store.transition(RUN_ID, { kind: "working", iteration: 2 }),
      );
      expect(result._tag).toBe("Failure");

      const loaded = await Effect.runPromise(store.get(RUN_ID));
      expect(loaded?.state.kind).toBe("completed");
    });

    it("fails a transition on a run that does not exist", async () => {
      const result = await Effect.runPromiseExit(
        store.transition(OTHER_RUN_ID, { kind: "working", iteration: 1 }),
      );
      expect(result._tag).toBe("Failure");
    });

    it("lists only non-terminal runs, newest first", async () => {
      await Effect.runPromise(
        store.save(record(RUN_ID, "agent-1", new Date("2026-08-23T10:00:00Z"))),
      );
      await Effect.runPromise(
        store.save(record(OTHER_RUN_ID, "agent-2", new Date("2026-08-23T12:00:00Z"))),
      );
      await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "completed", content: "done" }));

      const active = await Effect.runPromise(store.listActive());
      expect(active.map((entry) => entry.runId)).toEqual([OTHER_RUN_ID]);
    });

    it("filters a listing by agent", async () => {
      await Effect.runPromise(store.save(record(RUN_ID, "agent-1")));
      await Effect.runPromise(store.save(record(OTHER_RUN_ID, "agent-2")));

      const active = await Effect.runPromise(store.listActive({ agentId: "agent-2" }));
      expect(active.map((entry) => entry.runId)).toEqual([OTHER_RUN_ID]);
    });

    it("abandons a parked run past its deadline, and leaves a fresh one alone", async () => {
      await Effect.runPromise(store.save(record(RUN_ID)));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(store.transition(RUN_ID, parkedState("2026-08-23T09:00:00.000Z")));

      await Effect.runPromise(store.save(record(OTHER_RUN_ID)));
      await Effect.runPromise(store.transition(OTHER_RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(
        store.transition(OTHER_RUN_ID, parkedState("2026-09-01T00:00:00.000Z")),
      );

      const outcome = await Effect.runPromise(
        store.prune({ now: new Date("2026-08-23T12:00:00Z"), maxTerminalAgeMs: 60_000 }),
      );
      expect(outcome.abandoned).toBe(1);

      const expired = await Effect.runPromise(store.get(RUN_ID));
      expect(expired?.state).toMatchObject({ kind: "failed", cause: "abandoned" });
      const alive = await Effect.runPromise(store.get(OTHER_RUN_ID));
      expect(alive?.state.kind).toBe("input-required");
    });

    it("deletes terminal records past the retention window", async () => {
      await Effect.runPromise(store.save(record(RUN_ID)));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 1 }));
      await Effect.runPromise(store.transition(RUN_ID, { kind: "completed", content: "done" }));

      const outcome = await Effect.runPromise(
        store.prune({ now: new Date("2030-01-01T00:00:00Z"), maxTerminalAgeMs: 60_000 }),
      );
      expect(outcome.deleted).toBe(1);
      expect(await Effect.runPromise(store.get(RUN_ID))).toBeUndefined();
    });
  });
}

suite("InMemoryRunStore", async () => new InMemoryRunStore(() => TRANSITION_AT));

let temporaryDirectory: string;
suite(
  "FileRunStore",
  async () => {
    temporaryDirectory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-runs-"));
    return new FileRunStore(temporaryDirectory, () => TRANSITION_AT);
  },
  async () => {
    await nodeFs.rm(temporaryDirectory, { recursive: true, force: true });
  },
);

describe("FileRunStore hardening", () => {
  it("refuses a run id that would escape the runs directory", async () => {
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-runs-"));
    const store = new FileRunStore(directory);
    expect(await Effect.runPromise(store.get("../../etc/passwd"))).toBeUndefined();
    await nodeFs.rm(directory, { recursive: true, force: true });
  });

  it("skips an unparseable record instead of failing the listing", async () => {
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-runs-"));
    const store = new FileRunStore(directory);
    await Effect.runPromise(store.save(record(RUN_ID)));
    await nodeFs.writeFile(path.join(directory, "garbage.json"), "{ not json", "utf-8");

    const active = await Effect.runPromise(store.listActive());
    expect(active.map((entry) => entry.runId)).toEqual([RUN_ID]);
    await nodeFs.rm(directory, { recursive: true, force: true });
  });

  it("reads back a record written by a different store instance", async () => {
    const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-runs-"));
    await Effect.runPromise(new FileRunStore(directory).save(record(RUN_ID)));

    const loaded = await Effect.runPromise(new FileRunStore(directory).get(RUN_ID));
    expect(loaded?.runId).toBe(RUN_ID);
    await nodeFs.rm(directory, { recursive: true, force: true });
  });
});
