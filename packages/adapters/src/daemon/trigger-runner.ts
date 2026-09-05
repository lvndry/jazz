/**
 * @fileoverview Firing due workflow schedules and self-registered wake triggers, on a plain
 * interval, from inside `jazz daemon`.
 *
 * This is the daemon's alternative to depending on `launchd`/`crontab` existing on the host.
 * Workflow due-ness reuses `runWorkflowCatchUp` unchanged — that function already contains the
 * only cron-due-computation this codebase has (`decideCatchUp`, via `cron-parser`), so ticking
 * it on an interval turns "catches up on startup" into "catches up continuously" for free.
 * Wake triggers are a separate, simpler case: a one-shot `fireAt` timestamp per trigger,
 * checked with a plain `<=` comparison — no cron math involved.
 */

import { sendDesktopNotification } from "@jazz/core/utils/desktop-notify";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { runInProcessScheduledWorkflows } from "@jazz/core/workflows/catch-up";
import { Effect } from "effect";
import { runDueJobs } from "@/adapters/daemon/job-worker";
import { runUnattendedTurn } from "@/adapters/daemon/unattended-resume";
import { sweepDueReminders } from "@/adapters/reminder-service";
import { sweepDueWakeTriggers } from "@/adapters/wake-trigger-service";

function wakeTriggerDirectory(): string {
  return `${getJazzHomeDirectory()}/wake-triggers`;
}

function reminderDirectory(): string {
  return `${getJazzHomeDirectory()}/reminders`;
}

/**
 * Telegram (`tg_...`) and Discord (`dc_...`) agents already sweep and deliver their own
 * reminders in-process from inside the bot bridge — see `reminder-service.ts`'s
 * `isBotHostedAgentId` for the full reasoning. This ticker-fallback sweep must skip them too,
 * or a reminder set from a chat would fire twice: once as the bot's own message, once as a
 * spurious desktop notification on whatever headless host happens to run `jazz daemon`.
 */
function isBotHostedAgentId(agentId: string): boolean {
  return agentId.startsWith("tg_") || agentId.startsWith("dc_");
}

export function fireWakeTrigger(
  agentId: string,
  trigger: { id: string; conversationId: string; prompt: string },
) {
  return runUnattendedTurn({
    agentId,
    conversationId: trigger.conversationId,
    prompt: trigger.prompt,
    fallbackTitle: trigger.prompt,
    source: "wake trigger",
    sourceId: trigger.id,
  });
}

/**
 * One tick: run any due workflow catch-up, fire any due wake triggers, then claim and run any
 * due background job batches.
 *
 * Failures in any part are logged and swallowed — a single bad trigger, job, or transient
 * catch-up error must never stop the ticker from running on the next interval.
 */
export function runDueTriggers(options: { readonly runWorkflows?: boolean } = {}) {
  return Effect.gen(function* () {
    if (options.runWorkflows === true) {
      yield* runInProcessScheduledWorkflows();
    }

    const due = yield* sweepDueWakeTriggers(wakeTriggerDirectory(), Date.now()).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    for (const { agentId, trigger } of due) {
      yield* fireWakeTrigger(agentId, trigger);
    }

    // Fallback for hosts with neither launchd nor `at`: the reliability upgrade in
    // `reminder-os-scheduler.ts` is best-effort, so this ticker still needs to catch anything
    // it missed. Bot-hosted reminders are excluded — their own bridge already delivers them.
    const dueReminders = yield* sweepDueReminders(reminderDirectory(), Date.now()).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    for (const { agentId, reminder } of dueReminders) {
      if (isBotHostedAgentId(agentId)) continue;
      yield* sendDesktopNotification("Jazz reminder", reminder.text);
    }

    yield* runDueJobs().pipe(Effect.catchAll(() => Effect.void));
  });
}
