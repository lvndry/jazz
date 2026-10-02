import { describe, expect, it } from "bun:test";
import { ToolActivityTracker } from "./tool-activity";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("ToolActivityTracker", () => {
  it("records a mutating call with its tool and path", () => {
    const tracker = new ToolActivityTracker();
    tracker.record({
      toolName: "write_file",
      riskLevel: "high-risk",
      path: "src/a.ts",
      at: at(1000),
    });
    expect(tracker.snapshot()).toEqual({
      lastMutatingAt: at(1000),
      lastMutatingTool: "write_file",
      lastMutatingPath: "src/a.ts",
      lastReadAt: "",
    });
  });

  it("records a read-only call separately and does not touch the mutating record", () => {
    const tracker = new ToolActivityTracker();
    tracker.record({ toolName: "write_file", riskLevel: "low-risk", path: "a.ts", at: at(1000) });
    tracker.record({ toolName: "read_file", riskLevel: "read-only", path: "b.ts", at: at(2000) });
    const snapshot = tracker.snapshot();
    expect(snapshot.lastMutatingTool).toBe("write_file");
    expect(snapshot.lastReadAt).toBe(at(2000));
  });

  it("treats an unknown-risk call as mutating, fail-closed", () => {
    const tracker = new ToolActivityTracker();
    tracker.record({ toolName: "execute_command", riskLevel: "unknown", at: at(500) });
    expect(tracker.snapshot().lastMutatingTool).toBe("execute_command");
  });

  it("keeps an earlier path when a later mutating call does not carry one", () => {
    const tracker = new ToolActivityTracker();
    tracker.record({ toolName: "edit_file", riskLevel: "low-risk", path: "a.ts", at: at(1000) });
    tracker.record({ toolName: "execute_command", riskLevel: "high-risk", at: at(2000) });
    const snapshot = tracker.snapshot();
    expect(snapshot.lastMutatingPath).toBe("a.ts");
    expect(snapshot.lastMutatingAt).toBe(at(2000));
    expect(snapshot.lastMutatingTool).toBe("execute_command");
  });

  it("starts with an empty snapshot", () => {
    expect(new ToolActivityTracker().snapshot()).toEqual({
      lastMutatingAt: "",
      lastMutatingTool: "",
      lastMutatingPath: "",
      lastReadAt: "",
    });
  });
});
