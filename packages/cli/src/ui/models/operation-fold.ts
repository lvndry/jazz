/**
 * A running call's arguments on one live row: the first line whole, the rest counted.
 * A multi-line command (a heredoc, a script) otherwise reads as its first line alone,
 * with nothing saying more is running.
 */

import type { ActivityState } from "../activity-state";

export interface FoldedOperation {
  readonly head: string;
  readonly hiddenLines: number;
}

export function foldOperation(text: string): FoldedOperation {
  const lines = text.trim().split("\n");
  return { head: (lines[0] ?? "").trimEnd(), hiddenLines: lines.length - 1 };
}

/** The hint beside a folded row, naming the key that prints the rest. */
export function foldHint(hiddenLines: number): string {
  return `ctrl+o for ${String(hiddenLines)} more line${hiddenLines === 1 ? "" : "s"}`;
}

/** The oldest running call whose arguments fold and have not been expanded yet. */
export function nextFoldedTool(
  activity: ActivityState,
  expandedToolCallIds: ReadonlySet<string>,
): { readonly toolCallId: string; readonly text: string } | undefined {
  if (activity.phase !== "tool-execution") {
    return undefined;
  }
  for (const tool of activity.tools) {
    const text = tool.argsPreview?.trim();
    if (text === undefined || expandedToolCallIds.has(tool.toolCallId)) {
      continue;
    }
    if (foldOperation(text).hiddenLines > 0) {
      return { toolCallId: tool.toolCallId, text };
    }
  }
  return undefined;
}
