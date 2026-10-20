import { describe, expect, test } from "bun:test";
import type { ActiveTool, ActivityState } from "../activity-state";
import { DETACH_HINT_DELAY_MS, holdsTurnUp, offersDetach } from "./tool-detach";

const NOW = 100_000;

function running(...tools: ActiveTool[]): ActivityState {
  return { phase: "tool-execution", agentName: "jazz", tools };
}

function tool(ageMs: number, overrides: Partial<ActiveTool> = {}): ActiveTool {
  return {
    toolCallId: "call-1",
    toolName: "execute_command",
    startedAt: NOW - ageMs,
    ...overrides,
  };
}

describe("offersDetach", () => {
  test("offers once a running call passes the delay", () => {
    expect(offersDetach(running(tool(DETACH_HINT_DELAY_MS)), true, NOW)).toBe(true);
  });

  test("stays quiet for a call that has only just started", () => {
    expect(offersDetach(running(tool(DETACH_HINT_DELAY_MS - 1)), true, NOW)).toBe(false);
  });

  test("stays quiet when the run installed no background handler", () => {
    expect(offersDetach(running(tool(60_000)), false, NOW)).toBe(false);
  });

  test("stays quiet outside tool execution", () => {
    expect(offersDetach({ phase: "thinking", agentName: "jazz" }, true, NOW)).toBe(false);
  });

  test("ignores a call still being risk-classified", () => {
    expect(offersDetach(running(tool(60_000, { classifying: true })), true, NOW)).toBe(false);
  });

  test("offers when any one call in a parallel batch is long enough", () => {
    const batch = running(tool(500), tool(DETACH_HINT_DELAY_MS + 1, { toolCallId: "call-2" }));
    expect(offersDetach(batch, true, NOW)).toBe(true);
  });
});

describe("holdsTurnUp", () => {
  test("holds once a running call passes the delay, with or without a background handler", () => {
    expect(holdsTurnUp(running(tool(DETACH_HINT_DELAY_MS)), NOW)).toBe(true);
  });

  test("does not hold for a call that has only just started", () => {
    expect(holdsTurnUp(running(tool(DETACH_HINT_DELAY_MS - 1)), NOW)).toBe(false);
  });

  test("ignores a call still being risk-classified", () => {
    expect(holdsTurnUp(running(tool(60_000, { classifying: true })), NOW)).toBe(false);
  });
});
