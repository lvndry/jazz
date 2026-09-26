import type { LoopRecord, LoopSchedule } from "@jazz/core/agent/loop/loop-record";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { formatCompactCount } from "@jazz/core/utils/string";

export function describeLoopSchedule(schedule: LoopSchedule): string {
  if (schedule.kind === "cron") {
    const described = describeCronSchedule(schedule.expression) ?? schedule.expression;
    return schedule.timezone !== undefined ? `${described} (${schedule.timezone})` : described;
  }
  const minutes = Math.round(schedule.everyMs / 60_000);
  return minutes % 60 === 0 ? `every ${String(minutes / 60)}h` : `every ${String(minutes)}m`;
}

function describeState(loop: LoopRecord): string {
  switch (loop.state.kind) {
    case "active":
      return loop.run !== undefined
        ? `running (run ${loop.run.runId}${loop.run.stopAfter !== undefined ? `, will ${loop.run.stopAfter} after it` : ""})`
        : `next run ${loop.nextRunAt}`;
    case "failed":
      return `stopped: ${loop.state.reason}`;
    case "budget-limited":
      return `budget-limited (${loop.state.limit})`;
    case "completed":
      return `completed: ${loop.state.reason}`;
    default:
      return loop.state.kind;
  }
}

/** One loop as a listing shows it. */
export function describeLoop(loop: LoopRecord): string[] {
  const runs =
    loop.budget.maxRuns !== undefined
      ? `${String(loop.usage.runs)}/${String(loop.budget.maxRuns)}`
      : String(loop.usage.runs);
  return [
    `${loop.loopId}  ${describeLoopSchedule(loop.schedule)}: ${loop.prompt}`,
    `  ${describeState(loop)} · runs unasked: ${loop.approvalPolicy ?? "read-only and low-risk tools"}`,
    `  runs ${runs} · tokens ${formatCompactCount(loop.usage.totalTokens)}/${formatCompactCount(loop.budget.maxTokens)}${loop.budget.expiresAt !== undefined ? ` · ends ${loop.budget.expiresAt}` : ""}`,
    ...(loop.lastRun !== undefined
      ? [`  last (${loop.lastRun.outcome}): ${loop.lastRun.summary ?? "no output"}`]
      : []),
  ];
}
