/** Verifies the StreamEvent → plugin lifecycle mapping (tool, approval, sub-agent brackets). */

import { describe, expect, it } from "bun:test";
import { lifecycleEventForStreamEvent } from "./lifecycle-bridge";

describe("lifecycleEventForStreamEvent", () => {
  it("maps tool execution start", () => {
    expect(
      lifecycleEventForStreamEvent({
        type: "tool_execution_start",
        toolName: "read_file",
        toolCallId: "c1",
      }),
    ).toEqual({ event: "tool-start", data: { tool: "read_file", toolCallId: "c1" } });
  });

  it("maps a successful completion to tool-end and a failure to tool-error", () => {
    expect(
      lifecycleEventForStreamEvent({
        type: "tool_execution_complete",
        toolCallId: "c1",
        result: "ok",
        durationMs: 12,
        summary: "read 3 lines",
      }),
    ).toEqual({
      event: "tool-end",
      data: { toolCallId: "c1", durationMs: 12, summary: "read 3 lines" },
    });

    expect(
      lifecycleEventForStreamEvent({
        type: "tool_execution_complete",
        toolCallId: "c2",
        result: "",
        durationMs: 5,
        success: false,
        error: "boom",
      }),
    ).toEqual({ event: "tool-error", data: { toolCallId: "c2", durationMs: 5, error: "boom" } });
  });

  it("maps approval required and denied, but not an approved resolution", () => {
    expect(
      lifecycleEventForStreamEvent({
        type: "approval_required",
        toolCallId: "c3",
        toolName: "execute_command",
        message: "run?",
        riskLevel: "high-risk",
      }),
    ).toEqual({
      event: "permission-request",
      data: { tool: "execute_command", toolCallId: "c3", riskLevel: "high-risk" },
    });

    expect(
      lifecycleEventForStreamEvent({
        type: "approval_resolved",
        toolCallId: "c3",
        toolName: "execute_command",
        approved: false,
        auto: false,
      }),
    ).toEqual({
      event: "permission-denied",
      data: { tool: "execute_command", toolCallId: "c3", auto: false },
    });

    expect(
      lifecycleEventForStreamEvent({
        type: "approval_resolved",
        toolCallId: "c3",
        toolName: "execute_command",
        approved: true,
        auto: true,
      }),
    ).toBeUndefined();
  });

  it("maps sub-agent brackets", () => {
    expect(
      lifecycleEventForStreamEvent({
        type: "subagent_start",
        agentName: "researcher",
        task: "dig",
      }),
    ).toEqual({ event: "subagent-start", data: { agentName: "researcher", task: "dig" } });

    expect(
      lifecycleEventForStreamEvent({
        type: "subagent_complete",
        agentName: "researcher",
        durationMs: 900,
      }),
    ).toEqual({ event: "subagent-stop", data: { agentName: "researcher", durationMs: 900 } });
  });

  it("ignores events it does not bridge", () => {
    expect(
      lifecycleEventForStreamEvent({
        type: "text_chunk",
        delta: "x",
        accumulated: "x",
        sequence: 1,
      }),
    ).toBeUndefined();
  });
});
