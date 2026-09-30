import { describe, expect, test } from "bun:test";
import {
  derivePaneState,
  paneBlockedReason,
  type PaneStateSnapshot,
} from "@/cli/integrations/pane-state";

function snapshot(overrides: Partial<PaneStateSnapshot> = {}): PaneStateSnapshot {
  return {
    activity: { phase: "idle" } as PaneStateSnapshot["activity"],
    approvalRequest: null,
    activeMenu: null,
    currentConversation: null,
    ...overrides,
  };
}

function activity(phase: PaneStateSnapshot["activity"]["phase"]): PaneStateSnapshot["activity"] {
  return { phase } as PaneStateSnapshot["activity"];
}

describe("derivePaneState", () => {
  test("maps in-flight turn phases to working", () => {
    for (const phase of ["awaiting", "thinking", "streaming", "tool-execution"] as const) {
      expect(derivePaneState(snapshot({ activity: activity(phase) }))).toBe("working");
    }
  });

  test("maps quiet phases to idle", () => {
    for (const phase of ["idle", "complete", "error"] as const) {
      expect(derivePaneState(snapshot({ activity: activity(phase) }))).toBe("idle");
    }
  });

  test("a pending approval blocks even while a turn is in flight", () => {
    const state = derivePaneState(
      snapshot({
        activity: activity("tool-execution"),
        approvalRequest: { toolName: "execute_command", args: { command: "npm install" } },
      }),
    );
    expect(state).toBe("blocked");
  });

  test("an active menu blocks the state", () => {
    expect(derivePaneState(snapshot({ activeMenu: { id: "some-question" } }))).toBe("blocked");
  });

  test("approval takes precedence over menu", () => {
    const state = derivePaneState(
      snapshot({
        approvalRequest: { toolName: "execute_command", args: {} },
        activeMenu: { id: "m" },
      }),
    );
    expect(state).toBe("blocked");
  });
});

describe("paneBlockedReason", () => {
  test("labels an approval with tool and command", () => {
    const reason = paneBlockedReason(
      snapshot({
        approvalRequest: { toolName: "execute_command", args: { command: "npm install" } },
      }),
    );
    expect(reason).toEqual({
      kind: "approval",
      label: "Approval needed: execute_command npm install",
    });
  });

  test("labels an approval without a command", () => {
    const reason = paneBlockedReason(
      snapshot({ approvalRequest: { toolName: "write_file", args: {} } }),
    );
    expect(reason?.label).toBe("Approval needed: write_file");
  });

  test("falls back when the command arg is not a string", () => {
    const reason = paneBlockedReason(
      snapshot({ approvalRequest: { toolName: "execute_command", args: { command: 42 } } }),
    );
    expect(reason?.label).toBe("Approval needed: execute_command");
  });

  test("labels an active menu as waiting on input", () => {
    const reason = paneBlockedReason(snapshot({ activeMenu: { id: "q1" } }));
    expect(reason).toEqual({ kind: "question", label: "Waiting on your input" });
  });

  test("returns undefined when nothing is asking for the user", () => {
    expect(paneBlockedReason(snapshot())).toBeUndefined();
  });
});
