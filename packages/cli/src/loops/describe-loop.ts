import { pendingLoopInput } from "@jazz/adapters/loops/loop-actions";
import type { PendingRunInput } from "@jazz/adapters/runs/resume-owned-run";
import type { LoopRecord, LoopSchedule } from "@jazz/core/agent/loop/loop-record";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { formatCompactCount } from "@jazz/core/utils/string";
import { Effect } from "effect";

/** Where a loop is described, which decides how its commands are spelled. */
export type LoopSurface = "chat" | "cli";

/** What a loop's run waits on from the user (see `pendingLoopInput`). */
export type PendingLoopInput = Pick<PendingRunInput, "kind" | "described">;

export function describeLoopSchedule(schedule: LoopSchedule): string {
  if (schedule.kind === "cron") {
    const described = describeCronSchedule(schedule.expression) ?? schedule.expression;
    return schedule.timezone !== undefined ? `${described} (${schedule.timezone})` : described;
  }
  const minutes = Math.round(schedule.everyMs / 60_000);
  return minutes % 60 === 0 ? `every ${String(minutes / 60)}h` : `every ${String(minutes)}m`;
}

/** The loop's state as a person would say it. */
export function loopStatus(loop: LoopRecord, pending?: PendingLoopInput): string {
  switch (loop.state.kind) {
    case "active":
      if (pending !== undefined) {
        return pending.kind === "question" ? "waiting for your answer" : "waiting for approval";
      }
      if (loop.run !== undefined) {
        return loop.run.stopAfter !== undefined
          ? `running, will ${loop.run.stopAfter} after this run`
          : "running";
      }
      return `next run ${loop.nextRunAt}`;
    case "paused":
      return "paused";
    case "failed":
      return `stopped: ${loop.state.reason}`;
    case "budget-limited":
      return `out of ${loop.state.limit} budget`;
    case "completed":
      return `completed: ${loop.state.reason}`;
    case "canceled":
      return "canceled";
  }
}

/** The commands that move the loop on from where it is, spelled for the surface. */
export function nextLoopCommands(
  loop: LoopRecord,
  surface: LoopSurface,
  pending?: PendingLoopInput,
): string[] {
  const command = surface === "chat" ? "/loop" : "jazz loop";
  const name = loop.name;
  switch (loop.state.kind) {
    case "active":
      if (pending !== undefined) {
        return pending.kind === "question"
          ? [`${command} answer ${name} <your answer>`, `${command} cancel ${name}`]
          : [`${command} approve ${name}`, `${command} reject ${name} [why]`];
      }
      return loop.run?.stopAfter !== undefined
        ? []
        : [`${command} pause ${name}`, `${command} cancel ${name}`];
    case "paused":
    case "failed":
      return [`${command} resume ${name}`, `${command} cancel ${name}`];
    case "budget-limited":
      return [`${command} resume ${name} (adds one default budget)`, `${command} cancel ${name}`];
    default:
      return [];
  }
}

const UNATTENDED_GRANTS: Record<ApprovalPolicyLevel, string> = {
  "read-only": "read only",
  "low-risk": "read and make low-risk changes",
  "high-risk": "run anything, including commands flagged high-risk",
};

/** One loop as a block: status, prompt, usage, what it waits on, and what to do next. */
export function describeLoop(
  loop: LoopRecord,
  surface: LoopSurface,
  pending?: PendingLoopInput,
): string {
  const runs =
    loop.budget.maxRuns !== undefined
      ? `run ${String(loop.usage.runs)} of ${String(loop.budget.maxRuns)}`
      : `${String(loop.usage.runs)} ${loop.usage.runs === 1 ? "run" : "runs"}`;
  const next = nextLoopCommands(loop, surface, pending);
  return [
    `Loop ${loop.name} · ${describeLoopSchedule(loop.schedule)} · ${loopStatus(loop, pending)}`,
    `  ${loop.prompt.split("\n").join(" ")}`,
    `  Usage: ${runs} · ${formatCompactCount(loop.usage.totalTokens)} of ${formatCompactCount(loop.budget.maxTokens)} tokens · ${String(Math.round(loop.usage.activeDurationMs / 60_000))} of ${String(Math.round(loop.budget.maxDurationMs / 60_000))} min${loop.budget.expiresAt !== undefined ? ` · ends ${loop.budget.expiresAt}` : ""}`,
    `  Without asking it may: ${loop.approvalPolicy !== undefined ? UNATTENDED_GRANTS[loop.approvalPolicy] : "nothing (every gated call waits for you)"}`,
    ...(pending !== undefined ? [`  Waiting on: ${pending.described}`] : []),
    ...(loop.lastRun !== undefined
      ? [
          `  Last run (${loop.lastRun.outcome}): ${(loop.lastRun.summary ?? "no output").split("\n").join(" ")}`,
        ]
      : []),
    ...(next.length > 0 ? [`  Next: ${next.join("  ·  ")}`] : []),
  ].join("\n");
}

/** `describeLoop`, with what a waiting loop is waiting on looked up from its run. */
export function describeLoopNow(loop: LoopRecord, surface: LoopSurface) {
  return Effect.map(pendingLoopInput(loop), (pending) => describeLoop(loop, surface, pending));
}
