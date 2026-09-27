/**
 * Reminders: swept on an interval and delivered via an injected `send`
 * callback (so this module stays independent of the Discord API and the
 * bridge). Storage lives in core; this module only sweeps and fires.
 */

import { deliverDueReminders } from "@jazz/bot-shared/reminder-sweep";
import { channelIdFromAgentId } from "./agents";

export type ReminderSender = (channelId: string, markdown: string) => Promise<unknown>;

export const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

async function fireDueReminders(dataDir: string, send: ReminderSender): Promise<void> {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  try {
    await deliverDueReminders({
      dataDir,
      decodeScope: (agentId) => channelIdFromAgentId(agentId) ?? undefined,
      deliver: (channelId, reminderText, late) =>
        send(channelId, `⏰ **Reminder**${late ? " (delayed)" : ""}\n${reminderText}`),
    });
  } finally {
    reminderSweepRunning = false;
  }
}

export function startReminderSweep(dataDir: string, send: ReminderSender): void {
  const sweep = (): void => {
    void fireDueReminders(dataDir, send).catch((error) =>
      console.error(`Reminder sweep failed: ${String(error)}`),
    );
  };
  sweep();
  setInterval(sweep, REMINDER_SWEEP_MS);
}
