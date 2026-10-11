import type { ToolProgressEvent } from "@/core/types/tools";

/** Tools whose success means the child left something different on disk. */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "rm",
  "mv",
  "cp",
  "mkdir",
]);

function countsLabel(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([toolName, count]) => `${toolName} ×${String(count)}`).join(", ");
}

/**
 * What a child got done, kept from its tool events so a failure can say so.
 *
 * A child that dies on a model call hands its parent only an error, and the parent cannot tell a
 * child that wrote half the file from one that never started. This records the difference.
 */
export interface SubagentWorkDigest {
  readonly record: (event: ToolProgressEvent) => void;
  /** One sentence on the work done so far, for the end of a failure message. */
  readonly describe: () => string;
}

export function createSubagentWorkDigest(): SubagentWorkDigest {
  const finished = new Map<string, number>();
  const changedFiles = new Map<string, number>();
  const running = new Set<string>();
  let failedCalls = 0;

  return {
    record: (event) => {
      if (event.kind === "tool-started") {
        running.add(event.toolCallId ?? event.toolName);
        return;
      }
      if (event.kind !== "tool-finished") {
        return;
      }
      running.delete(event.toolCallId ?? event.toolName);
      finished.set(event.toolName, (finished.get(event.toolName) ?? 0) + 1);
      if (event.ok === false) {
        failedCalls += 1;
      } else if (FILE_CHANGING_TOOLS.has(event.toolName)) {
        changedFiles.set(event.toolName, (changedFiles.get(event.toolName) ?? 0) + 1);
      }
    },
    describe: () => {
      if (finished.size === 0 && running.size === 0) {
        return "It had made no tool calls before it stopped.";
      }
      const total = [...finished.values()].reduce((sum, count) => sum + count, 0);
      const parts = [
        total === 0
          ? "It had finished no tool calls"
          : `It had finished ${String(total)} tool call${total === 1 ? "" : "s"} (${countsLabel(finished)})`,
      ];
      if (failedCalls > 0) {
        parts.push(`${String(failedCalls)} of them failed`);
      }
      parts.push(
        changedFiles.size === 0
          ? "changed no files"
          : `changed files with ${countsLabel(changedFiles)}`,
      );
      const sentence = `${parts.join(", ")}.`;
      return running.size > 0
        ? `${sentence} It was partway through a tool call when it stopped.`
        : sentence;
    },
  };
}
