import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { ActivityState } from "./activity-state";
import { ActivityView } from "./ActivityView";
import { DETACH_HINT_DELAY_MS } from "./models/tool-detach";

function runningFor(ageMs: number): ActivityState {
  return {
    phase: "tool-execution",
    agentName: "jazz",
    tools: [{ toolCallId: "call-1", toolName: "execute_command", startedAt: Date.now() - ageMs }],
  };
}

describe("ActivityView", () => {
  test("offers Ctrl+B on a tool call that has run past the delay", () => {
    const output = renderToString(
      <ActivityView
        activity={runningFor(DETACH_HINT_DELAY_MS + 1_000)}
        canDetach
      />,
    );
    expect(output).toContain("ctrl+b to background");
  });

  test("leaves the hint off a call that has only just started", () => {
    const output = renderToString(
      <ActivityView
        activity={runningFor(0)}
        canDetach
      />,
    );
    expect(output).not.toContain("ctrl+b");
  });

  test("leaves the hint off when the run cannot detach", () => {
    const output = renderToString(<ActivityView activity={runningFor(60_000)} />);
    expect(output).not.toContain("ctrl+b");
  });
});
