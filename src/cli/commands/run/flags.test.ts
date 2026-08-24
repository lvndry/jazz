import { describe, expect, it } from "bun:test";
import type { StreamEvent } from "@/core/types/streaming";
import {
  eventsRequireStreaming,
  isApprovalPolicyFlag,
  isReasoningEffortFlag,
  parseEventCategories,
  resolveStreamOption,
} from "./flags";

describe("isApprovalPolicyFlag", () => {
  it("accepts the three risk levels", () => {
    expect(isApprovalPolicyFlag("read-only")).toBe(true);
    expect(isApprovalPolicyFlag("low-risk")).toBe(true);
    expect(isApprovalPolicyFlag("high-risk")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isApprovalPolicyFlag("all")).toBe(false);
    expect(isApprovalPolicyFlag("")).toBe(false);
  });
});

describe("parseEventCategories", () => {
  it("maps 'tools' to the four tool event types plus error", () => {
    const result = parseEventCategories("tools");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected: StreamEvent["type"][] = [
      "error",
      "tool_call",
      "tool_execution_complete",
      "tool_execution_start",
      "tools_detected",
    ];
    expect([...result.types].sort()).toEqual(expected.sort());
  });

  it("maps 'all' to every category type plus error", () => {
    const result = parseEventCategories("all");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected: StreamEvent["type"][] = [
      "error",
      "tools_detected",
      "tool_call",
      "tool_execution_start",
      "tool_execution_complete",
      "thinking_start",
      "thinking_chunk",
      "thinking_complete",
      "text_start",
      "text_chunk",
      "stream_start",
      "usage_update",
      "complete",
      "approval_required",
      "approval_resolved",
      "command_risk_classifying",
      "command_risk_classified",
      "subagent_start",
      "subagent_complete",
    ];
    expect([...result.types].sort()).toEqual(expected.sort());
  });

  it("unions multiple categories", () => {
    const result = parseEventCategories("tools,reasoning");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.types.has("tool_execution_start")).toBe(true);
    expect(result.types.has("thinking_chunk")).toBe(true);
    expect(result.types.has("text_chunk")).toBe(false);
    expect(result.types.has("error")).toBe(true);
  });

  it("tolerates whitespace and case", () => {
    const result = parseEventCategories(" Tools , TEXT ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.types.has("tool_execution_start")).toBe(true);
    expect(result.types.has("text_chunk")).toBe(true);
  });

  it("rejects an unknown category with a helpful message", () => {
    const result = parseEventCategories("bogus");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      'Invalid --events category "bogus". Expected: tools, reasoning, text, usage, approval, subagent, all.',
    );
  });

  it.each(["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"])(
    "rejects inherited Object.prototype key %p instead of treating it as a category",
    (inheritedKey) => {
      const result = parseEventCategories(inheritedKey);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Invalid --events category");
    },
  );
});

describe("isReasoningEffortFlag", () => {
  it("accepts the four reasoning levels", () => {
    expect(isReasoningEffortFlag("disable")).toBe(true);
    expect(isReasoningEffortFlag("low")).toBe(true);
    expect(isReasoningEffortFlag("medium")).toBe(true);
    expect(isReasoningEffortFlag("high")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isReasoningEffortFlag("off")).toBe(false);
    expect(isReasoningEffortFlag("none")).toBe(false);
    expect(isReasoningEffortFlag("")).toBe(false);
    expect(isReasoningEffortFlag("HIGH")).toBe(false);
  });
});

describe("eventsRequireStreaming", () => {
  it("is true for categories the batch path cannot produce", () => {
    for (const category of ["reasoning", "text", "all", "tools,reasoning"]) {
      const result = parseEventCategories(category);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(eventsRequireStreaming(result.types)).toBe(true);
    }
  });

  it("is false for categories the batch path routes through the renderer", () => {
    for (const category of ["tools", "approval", "subagent", "tools,subagent"]) {
      const result = parseEventCategories(category);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(eventsRequireStreaming(result.types)).toBe(false);
    }
  });
});

describe("resolveStreamOption", () => {
  const reasoning = parseEventCategories("tools,reasoning,text");
  const toolsOnly = parseEventCategories("tools");

  it("turns streaming on when the requested events only exist there", () => {
    expect(resolveStreamOption({}, reasoning)).toEqual({ stream: true });
  });

  it("leaves the TTY heuristic alone for events the batch path can produce", () => {
    expect(resolveStreamOption({}, toolsOnly)).toEqual({});
    expect(resolveStreamOption({}, undefined)).toEqual({});
  });

  it("lets an explicit --no-stream win over the events request", () => {
    expect(resolveStreamOption({ noStream: true }, reasoning)).toEqual({ stream: false });
  });

  it("honours an explicit --stream with no events at all", () => {
    expect(resolveStreamOption({ stream: true }, undefined)).toEqual({ stream: true });
  });

  it("ignores an unparseable --events value rather than forcing a mode on it", () => {
    expect(resolveStreamOption({}, parseEventCategories("bogus"))).toEqual({});
  });
});
