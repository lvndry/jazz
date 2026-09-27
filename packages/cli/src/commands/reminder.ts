import { deliverReminder, reminderDirectory } from "@jazz/adapters/daemon/trigger-runner";
import { claimReminder } from "@jazz/adapters/reminder-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { createReminderOsScheduler } from "@jazz/core/wake-triggers/reminder-os-scheduler";
import { Effect } from "effect";

/**
 * Internal command invoked by the host scheduler (launchd/`at`), not meant for interactive use:
 * fire one specific reminder, one-shot, as a native OS desktop notification, or through the
 * notify channels that take reminders when no desktop notification can be shown. A reminder
 * is "notify a person," never "resume the agent"; see `wake-trigger.ts` for the sibling that
 * does resume a conversation.
 *
 * The reminder is claimed under its agent's lock before anything is shown, so the daemon's
 * ticker (which claims the same way) can never deliver it a second time; if the ticker got
 * there first, this does nothing. The record is removed only once the reminder was shown or
 * handed to a notify channel; when neither was possible, it stays on disk as failed with that
 * reason. Either way the host scheduler's one-shot job is removed at the end, since it has
 * fired.
 */
export function fireReminderCommand(options: { agent: string; id: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const osScheduler = yield* createReminderOsScheduler();
    const reminder = yield* claimReminder(reminderDirectory(), options.agent, options.id);

    if (reminder === undefined) {
      yield* logger.info("Reminder not claimed: already delivered, being delivered, or cancelled");
    } else {
      const settled = yield* deliverReminder(options.agent, reminder);
      if (settled === undefined) {
        yield* logger.info("Reminder delivered");
      } else {
        yield* logger.warn("Reminder could not be delivered; kept for retry", {
          attempts: settled.delivery?.attempts,
        });
      }
    }

    yield* osScheduler
      .cancelFire(options.agent, options.id, reminder?.osSchedulerJobId)
      .pipe(Effect.catchAll(() => Effect.void));
  });
}
