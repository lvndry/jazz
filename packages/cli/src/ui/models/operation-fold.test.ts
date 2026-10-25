import { describe, expect, it } from "bun:test";
import type { ActivityState } from "../activity-state";
import { foldHint, foldOperation, nextFoldedTool } from "./operation-fold";

const HEREDOC_COMMAND = `date "+%H:%M"\npython3 <<'EOF'\nprint("hi")\nEOF`;

function running(...tools: { toolCallId: string; argsPreview?: string }[]): ActivityState {
  return {
    phase: "tool-execution",
    agentName: "agent",
    tools: tools.map((tool) => ({ ...tool, toolName: "execute_command", startedAt: 0 })),
  };
}

describe("foldOperation", () => {
  it("keeps the first line whole and counts the rest", () => {
    expect(foldOperation(HEREDOC_COMMAND)).toEqual({ head: 'date "+%H:%M"', hiddenLines: 3 });
  });

  it("leaves a one-line operation unfolded", () => {
    expect(foldOperation("ls -la\n")).toEqual({ head: "ls -la", hiddenLines: 0 });
  });
});

describe("foldHint", () => {
  it("names the key and the count", () => {
    expect(foldHint(1)).toBe("ctrl+o for 1 more line");
    expect(foldHint(3)).toBe("ctrl+o for 3 more lines");
  });
});

describe("nextFoldedTool", () => {
  it("returns the first running call with hidden lines", () => {
    const activity = running(
      { toolCallId: "short", argsPreview: "ls" },
      { toolCallId: "long", argsPreview: HEREDOC_COMMAND },
    );
    expect(nextFoldedTool(activity, new Set())).toEqual({
      toolCallId: "long",
      text: HEREDOC_COMMAND,
    });
  });

  it("skips calls already expanded", () => {
    const activity = running({ toolCallId: "long", argsPreview: HEREDOC_COMMAND });
    expect(nextFoldedTool(activity, new Set(["long"]))).toBeUndefined();
  });

  it("returns nothing outside tool execution", () => {
    expect(nextFoldedTool({ phase: "idle" }, new Set())).toBeUndefined();
  });
});
