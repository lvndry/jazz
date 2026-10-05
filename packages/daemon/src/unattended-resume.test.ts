import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { RunStoreTag, type RunStore } from "@jazz/core/interfaces/run-store";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { classifyTurnOutcome, hasParkedRun } from "./unattended-resume";

const TRANSCRIPT: ChatMessage[] = [
  { role: "user", content: "batch finished" },
  { role: "assistant", content: "looking" },
];

function park(overrides: Record<string, unknown> = {}): RunParkRequested {
  return new RunParkRequested({
    pending: {
      kind: "tool-approval",
      request: {
        toolCallId: "call_1",
        toolName: "execute_command",
        message: "Command: git status",
        executeToolName: "execute_execute_command",
        executeArgs: {},
      },
    },
    messages: TRANSCRIPT,
    runId: "run-1",
    expiresAt: "2026-01-02T00:00:00Z",
    ...overrides,
  } as ConstructorParameters<typeof RunParkRequested>[0]);
}

describe("classifyTurnOutcome", () => {
  /**
   * The regression: a park leaves the runner as a failure, and reading it as one logged an
   * empty message, skipped the save so the turn was lost, and told nobody a run was waiting.
   */
  it("reads a park as parked, not as a failure", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: park() });

    expect(outcome.kind).toBe("parked");
  });

  it("carries the transcript the parked turn produced, so it can still be saved", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: park() });

    if (outcome.kind !== "parked") throw new Error("expected a park");
    expect(outcome.messages).toEqual(TRANSCRIPT);
  });

  it("names the run to resume and what it stopped on", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: park() });

    if (outcome.kind !== "parked") throw new Error("expected a park");
    expect(outcome.runId).toBe("run-1");
    expect(outcome.waitingOn).toBe("execute_command");
    expect(outcome.expiresAt).toBe("2026-01-02T00:00:00Z");
  });

  it("calls a park with no run id unresumable rather than pointing at nothing", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: park({ runId: undefined }) });

    expect(outcome.kind).toBe("unresumable");
  });

  it("still reads a genuine error as a failure, with its message intact", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: new Error("provider exploded") });

    expect(outcome).toEqual({ kind: "failed", error: "provider exploded" });
  });

  it("reads a completed run as finished, with its messages", () => {
    const outcome = classifyTurnOutcome({ ok: true, messages: TRANSCRIPT });

    expect(outcome).toEqual({ kind: "finished", messages: TRANSCRIPT });
  });

  it("tolerates a completed run that carried no messages", () => {
    const outcome = classifyTurnOutcome({ ok: true });

    expect(outcome).toEqual({ kind: "finished", messages: [] });
  });
});

describe("hasParkedRun", () => {
  function storeWith(states: readonly string[]): RunStore {
    const runs = states.map((kind) => ({ state: { kind } }) as unknown as RunRecord);
    return { list: () => Effect.succeed(runs) } as unknown as RunStore;
  }

  it("holds a delivery back behind a run parked on an approval", async () => {
    const parked = hasParkedRun("conv-1").pipe(
      Effect.provideService(RunStoreTag, storeWith(["working", "input-required"])),
    );
    expect(await Effect.runPromise(parked)).toBe(true);
  });

  it("lets a delivery through when nothing in the conversation is parked", async () => {
    const working = hasParkedRun("conv-1").pipe(
      Effect.provideService(RunStoreTag, storeWith(["working"])),
    );
    expect(await Effect.runPromise(working)).toBe(false);
    expect(await Effect.runPromise(hasParkedRun("conv-1"))).toBe(false);
  });
});
