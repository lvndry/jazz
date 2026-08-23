import { describe, expect, it } from "bun:test";
import {
  InvalidRunTransitionError,
  canTransition,
  isParked,
  isTerminal,
  transition,
  type RunState,
  type RunStateKind,
} from "./run-state";

const ALL_KINDS: readonly RunStateKind[] = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
];

const parkedSnapshot = { messages: [], iteration: 3 } as const;

function stateOf(kind: RunStateKind): RunState {
  switch (kind) {
    case "submitted":
      return { kind: "submitted" };
    case "working":
      return { kind: "working", iteration: 1 };
    case "input-required":
      return {
        kind: "input-required",
        pending: {
          kind: "tool-approval",
          request: {
            toolCallId: "call_1",
            toolName: "write_file",
            message: "Write to /tmp/x",
            executeToolName: "write_file_execute",
            executeArgs: {},
          },
        },
        snapshot: parkedSnapshot,
        expiresAt: "2026-08-24T00:00:00.000Z",
      };
    case "auth-required":
      return {
        kind: "auth-required",
        provider: "anthropic",
        snapshot: parkedSnapshot,
        expiresAt: "2026-08-24T00:00:00.000Z",
      };
    case "completed":
      return { kind: "completed", content: "done" };
    case "failed":
      return { kind: "failed", cause: "error", error: "boom" };
    case "canceled":
      return { kind: "canceled", at: "working" };
  }
}

describe("run state classification", () => {
  it("treats only the three end states as terminal", () => {
    const terminal = ALL_KINDS.filter((kind) => isTerminal(stateOf(kind)));
    expect(terminal).toEqual(["completed", "failed", "canceled"]);
  });

  it("treats both blocked-on-a-person states as parked", () => {
    const parked = ALL_KINDS.filter((kind) => isParked(stateOf(kind)));
    expect(parked).toEqual(["input-required", "auth-required"]);
  });

  it("never classifies a state as both parked and terminal", () => {
    for (const kind of ALL_KINDS) {
      const state = stateOf(kind);
      expect(isParked(state) && isTerminal(state)).toBe(false);
    }
  });
});

describe("run transitions", () => {
  it("walks the happy path", () => {
    let state = stateOf("submitted");
    state = transition(state, stateOf("working"));
    state = transition(state, stateOf("completed"));
    expect(state.kind).toBe("completed");
  });

  it("parks on an approval and comes back through working", () => {
    let state = transition(stateOf("submitted"), stateOf("working"));
    state = transition(state, stateOf("input-required"));
    state = transition(state, stateOf("working"));
    expect(state.kind).toBe("working");
  });

  it("refuses to complete a parked run without resuming it", () => {
    expect(canTransition("input-required", "completed")).toBe(false);
    expect(canTransition("auth-required", "completed")).toBe(false);
  });

  it("lets every non-terminal state be canceled", () => {
    for (const kind of ALL_KINDS) {
      const state = stateOf(kind);
      expect(canTransition(kind, "canceled")).toBe(!isTerminal(state));
    }
  });

  it("lets a parked run expire into failure", () => {
    const abandoned: RunState = { kind: "failed", cause: "abandoned", error: "No answer." };
    expect(transition(stateOf("input-required"), abandoned).kind).toBe("failed");
  });

  it("never revives a terminal run", () => {
    for (const from of ALL_KINDS.filter((kind) => isTerminal(stateOf(kind)))) {
      for (const to of ALL_KINDS) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("throws with both ends named when the move is illegal", () => {
    expect(() => transition(stateOf("completed"), stateOf("working"))).toThrow(
      InvalidRunTransitionError,
    );
    expect(() => transition(stateOf("completed"), stateOf("working"))).toThrow(
      'A run cannot move from "completed" to "working".',
    );
  });

  it("does not let a run reach working without being started or resumed", () => {
    const intoWorking = ALL_KINDS.filter((kind) => canTransition(kind, "working"));
    expect(intoWorking).toEqual(["submitted", "input-required", "auth-required"]);
  });
});
