import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { ReminderServiceTag } from "@jazz/core/interfaces/reminder-service";
import { sendDesktopNotification } from "@jazz/core/utils/desktop-notify";
import { Effect } from "effect";

/**
 * Internal command invoked by the host scheduler (launchd/`at`), not meant for interactive use:
 * fire one specific reminder, one-shot, by sending a native OS desktop notification. A reminder
 * is "notify a person," never "resume the agent" — see `wake-trigger-tools.ts`'s file comment
 * for that distinction, and `wake-trigger.ts`'s `fireWakeTriggerCommand` for the sibling that
 * does resume a conversation.
 *
 * Cancels the reminder's JSON record before firing it, so the in-process ticker (or, for
 * Telegram/Discord, the bot's own sweep — though those never reach this command; see
 * `reminder-service.ts`) can never pick up the same reminder and deliver it a second time if
 * both race. A reminder that is no longer found (already fired or cancelled) is an expected
 * race, not an error — this exits cleanly rather than failing the scheduler job.
 */
export function fireReminderCommand(options: { agent: string; id: string }) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const reminderService = yield* ReminderServiceTag;

    const reminders = yield* reminderService.list(options.agent);
    const reminder = reminders.find((candidate) => candidate.id === options.id);

    if (reminder === undefined) {
      yield* logger.info("Reminder not found — likely already fired or cancelled", {
        agentId: options.agent,
        reminderId: options.id,
      });
      return;
    }

    yield* reminderService.cancel(options.agent, options.id);

    const delivered = yield* sendDesktopNotification("Jazz reminder", reminder.text);
    if (delivered) {
      yield* logger.info("Reminder delivered via desktop notification", {
        agentId: options.agent,
        reminderId: options.id,
      });
    } else {
      yield* logger.warn("Reminder desktop notification could not be delivered", {
        agentId: options.agent,
        reminderId: options.id,
      });
    }
  });
}
