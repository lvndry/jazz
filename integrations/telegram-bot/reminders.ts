/**
 * Reminders: swept on an interval and delivered via an injected `send`
 * callback (so this module stays independent of the Telegram API and the
 * bridge). Storage and time-parsing now live in core (`src/services/reminder-service.ts`,
 * `src/core/utils/when-parser.ts`) as one per-agent JSON file each, written by
 * the `add_reminder`/`cancel_reminder` tools the agent calls directly — this
 * module only sweeps for due reminders and fires them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { sweepDueReminders } from "@/services/reminder-service";
import { escapeHtml } from "./telegram-html";

/** Deliver a reminder message to a chat (HTML). Injected by the bridge. */
export type ReminderSender = (chatId: number, html: string) => Promise<unknown>;

export const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

// --- TEMPORARY migration shim ---------------------------------------------
// Before per-agent reminder files, all reminders lived in one flat
// `tg-reminders.json`. For one release the sweep also drains whatever is left
// in that file so nothing already scheduled is silently lost. Reminders are
// short-lived, low-stakes data, so this is a deliberately cheap compatibility
// read rather than a real migration script — delete this block (and its call
// site in fireDueReminders) once the old file has naturally drained.

interface LegacyReminder {
  id: string;
  chatId: number;
  fireAt: number;
  text: string;
  createdAt: number;
}

function legacyRemindersPath(dataDir: string): string {
  return join(dataDir, "tg-reminders.json");
}

function readLegacyReminders(dataDir: string): LegacyReminder[] {
  try {
    const path = legacyRemindersPath(dataDir);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed as LegacyReminder[];
  } catch {
    // ignore — treat as empty
  }
  return [];
}

function writeLegacyReminders(dataDir: string, reminders: LegacyReminder[]): void {
  try {
    writeFileSync(legacyRemindersPath(dataDir), `${JSON.stringify(reminders, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write legacy reminders: ${String(error)}`);
  }
}

async function fireDueLegacyReminders(
  dataDir: string,
  now: number,
  send: ReminderSender,
): Promise<void> {
  const reminders = readLegacyReminders(dataDir);
  const due = reminders.filter((reminder) => reminder.fireAt <= now);
  if (due.length === 0) return;
  // Remove first so a delivery failure can't loop-fire the same reminder.
  writeLegacyReminders(
    dataDir,
    reminders.filter((reminder) => reminder.fireAt > now),
  );
  for (const reminder of due) {
    const late = now - reminder.fireAt > 90_000 ? " (delayed)" : "";
    await send(reminder.chatId, `⏰ <b>Reminder</b>${late}\n${escapeHtml(reminder.text)}`);
  }
}

// --- End migration shim ----------------------------------------------------

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

    // TEMPORARY: also drain the pre-migration flat file — see block above.
    await fireDueLegacyReminders(dataDir, now, send);

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
