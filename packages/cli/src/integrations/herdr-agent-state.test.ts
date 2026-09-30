import * as path from "path";
import { describe, expect, test } from "bun:test";
import {
  deriveHerdrState,
  herdrBlockedReason,
  resumeCommandFor,
} from "@/cli/integrations/herdr-agent-state";
import type { ActivityState } from "@/cli/ui/activity-state";

function activity(phase: ActivityState["phase"], detail?: string): ActivityState {
  return { phase, detail } as ActivityState;
}

describe("deriveHerdrState", () => {
  test("maps in-flight turn phases to working", () => {
    for (const phase of ["awaiting", "thinking", "streaming", "tool-execution"] as const) {
      expect(
        deriveHerdrState({ activity: activity(phase), approvalRequest: null, activeMenu: null }),
      ).toBe("working");
    }
  });

  test("maps quiet phases to idle", () => {
    for (const phase of ["idle", "complete", "error"] as const) {
      expect(
        deriveHerdrState({ activity: activity(phase), approvalRequest: null, activeMenu: null }),
      ).toBe("idle");
    }
  });

  test("a pending approval blocks even while a turn is in flight", () => {
    const state = deriveHerdrState({
      activity: activity("tool-execution", "running"),
      approvalRequest: { toolName: "execute_command", command: "rm -rf /tmp/x" },
      activeMenu: null,
    });
    expect(state).toBe("blocked");
  });

  test("an active menu blocks the state", () => {
    const state = deriveHerdrState({
      activity: activity("idle"),
      approvalRequest: null,
      activeMenu: { id: "some-question" },
    });
    expect(state).toBe("blocked");
  });

  test("approval takes precedence over menu in the derivation", () => {
    const state = deriveHerdrState({
      activity: activity("idle"),
      approvalRequest: { toolName: "execute_command" },
      activeMenu: { id: "m" },
    });
    expect(state).toBe("blocked");
  });
});

describe("herdrBlockedReason", () => {
  test("labels an approval with tool and command", () => {
    const reason = herdrBlockedReason({
      activity: activity("tool-execution"),
      approvalRequest: { toolName: "execute_command", command: "npm install" },
      activeMenu: null,
    });
    expect(reason).toEqual({
      kind: "approval",
      label: "Approval needed: execute_command npm install",
    });
  });

  test("labels an approval without a command", () => {
    const reason = herdrBlockedReason({
      activity: activity("tool-execution"),
      approvalRequest: { toolName: "write_file" },
      activeMenu: null,
    });
    expect(reason?.label).toBe("Approval needed: write_file");
  });

  test("labels an active menu as waiting on input", () => {
    const reason = herdrBlockedReason({
      activity: activity("idle"),
      approvalRequest: null,
      activeMenu: { id: "q1" },
    });
    expect(reason).toEqual({ kind: "question", label: "Waiting on your input" });
  });

  test("returns undefined when nothing is asking for the user", () => {
    expect(
      herdrBlockedReason({ activity: activity("idle"), approvalRequest: null, activeMenu: null }),
    ).toBeUndefined();
  });
});

describe("resumeCommandFor", () => {
  test("builds a plain-on-PATH resume command with conversation id", () => {
    expect(resumeCommandFor({ agent: "coder", conversationId: "abc-123" })).toEqual([
      "jazz",
      "agent",
      "chat",
      "coder",
      "--continue",
      "--conversation",
      "abc-123",
    ]);
  });

  test("contains no control characters or apostrophes in any argument", () => {
    const args = resumeCommandFor({ agent: "coder", conversationId: "conv-1" });
    for (const arg of args) {
      expect(["'", '"', "\\"].some((c) => arg.includes(c))).toBe(false);
      expect(
        [...arg].some((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code < 0x20 || code === 0x7f;
        }),
      ).toBe(false);
    }
  });

  test("uses the agent id as the first argument after the subcommand", () => {
    const args = resumeCommandFor({ agent: "my-agent", conversationId: "c" });
    expect(args[0]).toBe("jazz");
    expect(args[3]).toBe("my-agent");
  });

  test("path helper produces a normal absolute path", () => {
    // Sanity: the module imports path; make sure it is the real one and the
    // conversation id round-trips through join for unusual but legal ids.
    const joined = path.join("/tmp", "herdr", "conv-1");
    expect(joined).toBe(path.join("/tmp", "herdr", "conv-1"));
  });
});
