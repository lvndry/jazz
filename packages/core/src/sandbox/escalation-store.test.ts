import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { createRunRecord, type RunRecord } from "@/core/agent/run/run-record";
import { RunStoreTag, type RunStore } from "@/core/interfaces/run-store";
import {
  addGrant,
  createEscalationLedger,
  MAX_STORED_GRANTS,
  removeGrant,
  seedLedgerFromGrants,
} from "./escalation";
import { clearGrant, storeGrant } from "./escalation-store";

function memoryStore(initial: RunRecord): { store: RunStore; current: () => RunRecord } {
  let record = initial;
  const store: RunStore = {
    save: (next) =>
      Effect.sync(() => {
        record = next;
      }),
    get: () => Effect.succeed(record),
    transition: () => Effect.fail(new Error("unused")),
    list: () => Effect.succeed([record]),
    prune: () => Effect.succeed({ abandoned: 0, deleted: 0, reparked: 0 }),
  };
  return { store, current: () => record };
}

const baseRecord = createRunRecord({
  runId: "run-1",
  agentId: "agent",
  conversationId: "conversation",
  input: "do it",
  now: new Date(0),
});

const command = 'echo x > "/outside/file"';
const deniedPath = "/outside/file";

describe("persisted escalation grants", () => {
  test("an offer made before a restart is spendable once in a fresh ledger", async () => {
    const { store, current } = memoryStore(baseRecord);
    await Effect.runPromise(
      storeGrant("run-1", { command, deniedPath }).pipe(
        Effect.provide(Layer.succeed(RunStoreTag, store)),
      ),
    );

    const freshLedger = createEscalationLedger();
    expect(freshLedger.peek("run-1", command)).toBeUndefined();
    seedLedgerFromGrants(freshLedger, "run-1", current().escalations);

    expect(freshLedger.peek("run-1", command)).toBe(deniedPath);
    expect(freshLedger.consume("run-1", command)).toBe(true);
    expect(freshLedger.consume("run-1", command)).toBe(false);
  });

  test("a changed command or another run finds no offer", () => {
    const freshLedger = createEscalationLedger();
    seedLedgerFromGrants(freshLedger, "run-1", [{ command, deniedPath }]);
    expect(freshLedger.consume("run-1", `${command}; rm -rf ~`)).toBe(false);
    expect(freshLedger.consume("run-2", command)).toBe(false);
  });

  test("spending the retry clears the stored grant so a later resume cannot reuse it", async () => {
    const { store, current } = memoryStore(baseRecord);
    const layer = Layer.succeed(RunStoreTag, store);
    await Effect.runPromise(
      storeGrant("run-1", { command, deniedPath }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(clearGrant("run-1", command).pipe(Effect.provide(layer)));

    const secondResume = createEscalationLedger();
    seedLedgerFromGrants(secondResume, "run-1", current().escalations);
    expect(secondResume.peek("run-1", command)).toBeUndefined();
  });

  test("without a run store or a record nothing is written and nothing fails", async () => {
    await Effect.runPromise(storeGrant("run-1", { command, deniedPath }));
    const empty: RunStore = {
      ...memoryStore(baseRecord).store,
      get: () => Effect.succeed(undefined),
    };
    await Effect.runPromise(
      storeGrant("run-9", { command, deniedPath }).pipe(
        Effect.provide(Layer.succeed(RunStoreTag, empty)),
      ),
    );
  });
});

describe("grant list helpers", () => {
  test("re-offering the same command replaces it and the list is bounded", () => {
    const once = addGrant(undefined, { command, deniedPath });
    expect(addGrant(once, { command: ` ${command} `, deniedPath: "/other" })).toEqual([
      { command: ` ${command} `, deniedPath: "/other" },
    ]);
    let grants = once;
    for (let index = 0; index < MAX_STORED_GRANTS + 5; index += 1) {
      grants = addGrant(grants, { command: `c${String(index)}`, deniedPath });
    }
    expect(grants).toHaveLength(MAX_STORED_GRANTS);
    expect(removeGrant(grants, "c20")).toHaveLength(MAX_STORED_GRANTS - 1);
  });
});
