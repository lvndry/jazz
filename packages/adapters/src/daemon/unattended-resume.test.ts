import { RunParkRequested } from "@jazz/core/agent/run/park-signal";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import { approvalNotification, classifyTurnOutcome } from "./unattended-resume";

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

describe("approvalNotification", () => {
  it("tells the reader which run to answer and how", () => {
    const outcome = classifyTurnOutcome({ ok: false, error: park() });
    if (outcome.kind !== "parked") throw new Error("expected a park");

    const notification = approvalNotification({ source: "job batch", sourceId: "b1" }, outcome);

    expect(notification.body).toContain("jazz runs resume run-1");
    expect(notification.body).toContain("execute_command");
    expect(notification.body).toContain("b1");
  });
});
