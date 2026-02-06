import { describe, expect, test } from "bun:test";
import { isActivityEqual, type ActivityState } from "./activity-state";

describe("isActivityEqual", () => {
  // ---------------------------------------------------------------------------
  // Reference equality
  // ---------------------------------------------------------------------------

  test("returns true for same reference", () => {
    const state: ActivityState = { phase: "idle" };
    expect(isActivityEqual(state, state)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Phase mismatch
  // ---------------------------------------------------------------------------

  test("returns false for different phases", () => {
    expect(
      isActivityEqual({ phase: "idle" }, { phase: "complete" }),
    ).toBe(false);
    expect(
      isActivityEqual(
        { phase: "thinking", agentName: "A", reasoning: "" },
        { phase: "streaming", agentName: "A", reasoning: "", text: "" },
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // idle / complete — no payload
  // ---------------------------------------------------------------------------

  test("idle states are always equal", () => {
    expect(isActivityEqual({ phase: "idle" }, { phase: "idle" })).toBe(true);
  });

  test("complete states are always equal", () => {
    expect(
      isActivityEqual({ phase: "complete" }, { phase: "complete" }),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // thinking
  // ---------------------------------------------------------------------------

  test("thinking states with same content are equal", () => {
    expect(
      isActivityEqual(
        { phase: "thinking", agentName: "Agent", reasoning: "hmm" },
        { phase: "thinking", agentName: "Agent", reasoning: "hmm" },
      ),
    ).toBe(true);
  });

  test("thinking states differ by agentName", () => {
    expect(
      isActivityEqual(
        { phase: "thinking", agentName: "A", reasoning: "" },
        { phase: "thinking", agentName: "B", reasoning: "" },
      ),
    ).toBe(false);
  });

  test("thinking states differ by reasoning", () => {
    expect(
      isActivityEqual(
        { phase: "thinking", agentName: "A", reasoning: "x" },
        { phase: "thinking", agentName: "A", reasoning: "y" },
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // streaming
  // ---------------------------------------------------------------------------

  test("streaming states with same content are equal", () => {
    expect(
      isActivityEqual(
        { phase: "streaming", agentName: "A", reasoning: "r", text: "t" },
        { phase: "streaming", agentName: "A", reasoning: "r", text: "t" },
      ),
    ).toBe(true);
  });

  test("streaming states differ by text", () => {
    expect(
      isActivityEqual(
        { phase: "streaming", agentName: "A", reasoning: "", text: "Hello" },
        { phase: "streaming", agentName: "A", reasoning: "", text: "Hello w" },
      ),
    ).toBe(false);
  });

  test("streaming states differ by reasoning", () => {
    expect(
      isActivityEqual(
        { phase: "streaming", agentName: "A", reasoning: "a", text: "t" },
        { phase: "streaming", agentName: "A", reasoning: "b", text: "t" },
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // tool-execution
  // ---------------------------------------------------------------------------

  test("tool-execution states with same tools are equal", () => {
    const tools = [
      { toolCallId: "1", toolName: "read", startedAt: 100 },
    ];
    expect(
      isActivityEqual(
        { phase: "tool-execution", agentName: "A", tools },
        { phase: "tool-execution", agentName: "A", tools: [{ toolCallId: "1", toolName: "read", startedAt: 200 }] },
      ),
    ).toBe(true); // startedAt is not compared
  });

  test("tool-execution states differ by tool count", () => {
    expect(
      isActivityEqual(
        {
          phase: "tool-execution",
          agentName: "A",
          tools: [{ toolCallId: "1", toolName: "read", startedAt: 0 }],
        },
        {
          phase: "tool-execution",
          agentName: "A",
          tools: [
            { toolCallId: "1", toolName: "read", startedAt: 0 },
            { toolCallId: "2", toolName: "write", startedAt: 0 },
          ],
        },
      ),
    ).toBe(false);
  });

  test("tool-execution states differ by tool name", () => {
    expect(
      isActivityEqual(
        {
          phase: "tool-execution",
          agentName: "A",
          tools: [{ toolCallId: "1", toolName: "read", startedAt: 0 }],
        },
        {
          phase: "tool-execution",
          agentName: "A",
          tools: [{ toolCallId: "1", toolName: "write", startedAt: 0 }],
        },
      ),
    ).toBe(false);
  });

  test("tool-execution states differ by agentName", () => {
    expect(
      isActivityEqual(
        { phase: "tool-execution", agentName: "A", tools: [] },
        { phase: "tool-execution", agentName: "B", tools: [] },
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // error
  // ---------------------------------------------------------------------------

  test("error states with same message are equal", () => {
    expect(
      isActivityEqual(
        { phase: "error", message: "boom" },
        { phase: "error", message: "boom" },
      ),
    ).toBe(true);
  });

  test("error states with different messages are not equal", () => {
    expect(
      isActivityEqual(
        { phase: "error", message: "a" },
        { phase: "error", message: "b" },
      ),
    ).toBe(false);
  });
});
