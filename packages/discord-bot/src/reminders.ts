/**
 * Reminders: swept on an interval and delivered via an injected `send`
 * callback (so this module stays independent of the Discord API and the
 * bridge). Storage lives in core; this module only sweeps and fires.
 */

import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { sweepDueReminders } from "@jazz/adapters/reminder-service";
import { Effect } from "effect";
import { channelIdFromAgentId } from "./agents";

export type ReminderSender = (channelId: string, markdown: string) => Promise<unknown>;

export const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

function remindersRootDir(dataDir: string): string {
  return join(dataDir, "reminders");
}

async function fireDueReminders(dataDir: string, send: ReminderSender): Promise<void> {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  try {
    const now = Date.now();
    const fired = await Effect.runPromise(
      sweepDueReminders(remindersRootDir(dataDir), now).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    for (const { agentId, reminder } of fired) {
      const channelId = channelIdFromAgentId(agentId);
      if (channelId === null) continue;
      const late = now - reminder.fireAt > 90_000 ? " (delayed)" : "";
      await send(channelId, `⏰ **Reminder**${late}\n${reminder.text}`);
    }
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
