/**
 * A sub-agent's run laid out as a command report, so `/subagents show` prints the log of one
 * that already left the list under the composer, in either renderer.
 */

import type { ReportRow, TerminalReport } from "@jazz/core/interfaces/terminal";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { subagentElapsedMs, type SubagentRun } from "../subagent-runs";
import { formatElapsed } from "../text/format";

const STATUS_WORDS = {
  running: "running",
  completed: "done",
  failed: "failed",
  interrupted: "interrupted",
} as const;

/** One line per run for `/subagents list`: `1. Label · done · 12s`. */
export function formatSubagentRun(run: SubagentRun, position: number, now: number): string {
  const lines = [
    `${String(position)}. ${run.label} · ${STATUS_WORDS[run.status]} · ${formatElapsed(subagentElapsedMs(run, now))}`,
  ];
  const activity = stripAnsiCodes(run.activity).trim();
  if (activity.length > 0) {
    lines.push(`   ${activity}`);
  }
  return lines.join("\n");
}

/** A run by its 1-based number in `/subagents list`, or by a prefix of its id. */
export function resolveSubagentRun(
  runs: readonly SubagentRun[],
  handle: string,
): SubagentRun | undefined {
  const position = Number(handle);
  if (Number.isInteger(position) && position >= 1) {
    return runs[position - 1];
  }
  const matches = runs.filter((run) => run.id.startsWith(handle));
  return matches.length === 1 ? matches[0] : undefined;
}

export function subagentReport(run: SubagentRun, now: number): TerminalReport {
  const rows: ReportRow[] = [
    { kind: "field", key: "status", value: STATUS_WORDS[run.status] },
    { kind: "field", key: "took", value: formatElapsed(subagentElapsedMs(run, now)) },
  ];
  if (run.task.trim().length > 0) {
    rows.push({ kind: "gap" }, { kind: "group", label: "brief" }, { kind: "text", text: run.task });
  }
  rows.push({ kind: "gap" }, { kind: "group", label: "log", count: String(run.entries.length) });
  if (run.entries.length === 0) {
    rows.push({ kind: "text", text: "nothing recorded yet", tone: "muted" });
  }
  for (const entry of run.entries) {
    switch (entry.kind) {
      case "tool":
        rows.push({
          kind: "item",
          name: entry.args.length > 0 ? `${entry.name} ${entry.args}` : entry.name,
          marker: entry.status === "failed" ? "attention" : "inactive",
          ...(entry.status === "failed" ? { tone: "error" as const } : {}),
          ...(entry.summary === undefined || entry.summary.length === 0
            ? {}
            : { detail: stripAnsiCodes(entry.summary) }),
        });
        break;
      case "response":
        rows.push({ kind: "text", text: stripAnsiCodes(entry.text).trim() });
        break;
      case "steer":
        rows.push({
          kind: "text",
          text: `${entry.sender === "parent" ? "parent agent" : "you"}: ${entry.text}`,
          tone: "accent",
        });
        break;
      case "reasoning":
      case "note":
        break;
    }
  }
  return { _tag: "report", label: run.label, rows };
}
