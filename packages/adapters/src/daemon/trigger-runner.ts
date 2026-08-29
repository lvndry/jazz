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

import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { sendDesktopNotification } from "@jazz/core/utils/desktop-notify";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { runInProcessScheduledWorkflows } from "@jazz/core/workflows/catch-up";
import { Effect } from "effect";
import { runDueJobs } from "@/adapters/daemon/job-worker";
import { sweepDueReminders } from "@/adapters/reminder-service";
import { sweepDueWakeTriggers } from "@/adapters/wake-trigger-service";
import {
  loadConversation,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";

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

/**
 * Resume the conversation a wake trigger belongs to and run its prompt as the next turn.
 *
 * Mirrors the CLI's own resume path (`packages/cli/src/commands/run/execute.ts`): load prior
 * history if any, pass it to `AgentRunner.run` explicitly (the runner never loads history on
 * its own), then persist the updated transcript. A trigger whose agent no longer exists is
 * logged and dropped rather than retried — there's nothing to resume it into.
 */
export function fireWakeTrigger(
  agentId: string,
  trigger: { id: string; conversationId: string; prompt: string },
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const agentResult = yield* getAgentByIdentifier(agentId).pipe(Effect.either);
    if (agentResult._tag === "Left") {
      yield* logger.warn("Wake trigger skipped: agent not found", {
        agentId,
        triggerId: trigger.id,
      });
      return;
    }
    const agent = agentResult.right;

    const priorRecord = yield* loadConversation(agentId, trigger.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    const response = yield* AgentRunner.run({
      agent,
      userInput: trigger.prompt,
      conversationId: trigger.conversationId,
      parkWhenUnattended: true,
      ...(priorRecord !== null ? { conversationHistory: priorRecord.messages } : {}),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* logger.warn("Wake trigger run failed", {
            agentId,
            triggerId: trigger.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }),
      ),
    );
    if (response === undefined) return;

    const now = new Date().toISOString();
    yield* saveConversation({
      agentId,
      conversationId: trigger.conversationId,
      title: priorRecord?.title ?? trigger.prompt.slice(0, 80),
      startedAt: priorRecord?.startedAt ?? now,
      endedAt: now,
      messages: response.messages ?? priorRecord?.messages ?? [],
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Wake trigger conversation save failed", {
          agentId,
          triggerId: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
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
