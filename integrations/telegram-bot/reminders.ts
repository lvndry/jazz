/**
 * Reminders: swept on an interval and delivered via an injected `send`
 * callback (so this module stays independent of the Telegram API and the
 * bridge). Storage and time-parsing now live in core (`src/services/reminder-service.ts`,
 * `src/core/utils/time.ts`) as one per-agent JSON file each, written by
 * the `add_reminder`/`cancel_reminder` tools the agent calls directly — this
 * module only sweeps for due reminders and fires them.
 */

import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { sweepDueReminders } from "@/services/reminder-service";
import { escapeHtml } from "./telegram-html";

/** Deliver a reminder message to a chat (HTML). Injected by the bridge. */
export type ReminderSender = (chatId: number, html: string) => Promise<unknown>;

export const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

/** `tg_<chatId>` with negative ids encoded as `n<abs>` → reverse of agentIdForChat (agents.ts). */
function chatIdFromAgentId(agentId: string): number | null {
  if (!agentId.startsWith("tg_")) return null;
  const suffix = agentId.slice("tg_".length);
  const numeric = suffix.startsWith("n") ? `-${suffix.slice(1)}` : suffix;
  const chatId = Number.parseInt(numeric, 10);
  return Number.isFinite(chatId) ? chatId : null;
}

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
      const chatId = chatIdFromAgentId(agentId);
      if (chatId === null) continue;
      const late = now - reminder.fireAt > 90_000 ? " (delayed)" : "";
      await send(chatId, `⏰ <b>Reminder</b>${late}\n${escapeHtml(reminder.text)}`);
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
  sweep(); // deliver anything that came due while the bridge was down
  setInterval(sweep, REMINDER_SWEEP_MS);
}
