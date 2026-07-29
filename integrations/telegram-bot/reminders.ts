/**
 * Reminders: a small on-disk queue swept on an interval and delivered via an
 * injected `send` callback (so this module stays independent of the Telegram
 * API and the bridge). `dataDir` is Jazz's home. Time parsing is timezone-aware
 * — see timezone.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wallClockToEpoch, zonedDateParts } from "./timezone";

export interface Reminder {
  id: string;
  chatId: number;
  fireAt: number;
  text: string;
  createdAt: number;
}

/** Deliver a reminder message to a chat (HTML). Injected by the bridge. */
export type ReminderSender = (chatId: number, html: string) => Promise<unknown>;

const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

function remindersPath(dataDir: string): string {
  return join(dataDir, "tg-reminders.json");
}

function newReminderId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function readReminders(dataDir: string): Reminder[] {
  try {
    const path = remindersPath(dataDir);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed as Reminder[];
  } catch {
    // ignore — treat as empty
  }
  return [];
}

function writeReminders(dataDir: string, reminders: Reminder[]): void {
  try {
    writeFileSync(remindersPath(dataDir), `${JSON.stringify(reminders, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write reminders: ${String(error)}`);
  }
}

export function addReminder(dataDir: string, chatId: number, fireAt: number, text: string): void {
  const reminders = readReminders(dataDir);
  reminders.push({ id: newReminderId(), chatId, fireAt, text, createdAt: Date.now() });
  writeReminders(dataDir, reminders);
}

export function cancelReminder(dataDir: string, chatId: number, id: string): boolean {
  const reminders = readReminders(dataDir);
  const remaining = reminders.filter(
    (reminder) => !(reminder.id === id && reminder.chatId === chatId),
  );
  if (remaining.length === reminders.length) return false;
  writeReminders(dataDir, remaining);
  return true;
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a "when" spec into an absolute epoch-ms, or null if unparseable.
 * Supports relative durations (30m, 2h, 1h30m, 90s, 1d), a 24h clock time
 * (HH:MM → next occurrence), and "tomorrow HH:MM". Clock times are interpreted
 * in the caller's `tz` so "18:00" means 6pm where the sender is.
 */
export function parseWhen(spec: string, now: number, tz: string): number | null {
  const trimmed = spec.trim().toLowerCase();

  const tomorrow = /^tomorrow\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  const clock = tomorrow ?? /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    const today = zonedDateParts(now, tz);
    const dayOffset = tomorrow ? 1 : 0;
    let fireAt = wallClockToEpoch(
      today.year,
      today.month,
      today.day + dayOffset,
      hours,
      minutes,
      tz,
    );
    if (!tomorrow && fireAt <= now) {
      fireAt = wallClockToEpoch(today.year, today.month, today.day + 1, hours, minutes, tz);
    }
    return fireAt;
  }

  let totalMs = 0;
  for (const match of trimmed.matchAll(/(\d+)\s*([smhd])/g)) {
    totalMs += Number(match[1]) * (DURATION_UNIT_MS[match[2] ?? ""] ?? 0);
  }
  const leftover = trimmed.replace(/(\d+)\s*([smhd])/g, "").trim();
  if (totalMs > 0 && leftover === "") return now + totalMs;

  return null;
}

async function fireDueReminders(dataDir: string, send: ReminderSender): Promise<void> {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  try {
    const now = Date.now();
    const reminders = readReminders(dataDir);
    const due = reminders.filter((reminder) => reminder.fireAt <= now);
    if (due.length === 0) return;
    // Remove first so a delivery failure can't loop-fire the same reminder.
    writeReminders(
      dataDir,
      reminders.filter((reminder) => reminder.fireAt > now),
    );
    for (const reminder of due) {
      const late = now - reminder.fireAt > 90_000 ? " (delayed)" : "";
      await send(reminder.chatId, `⏰ <b>Reminder</b>${late}\n${reminder.text}`);
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
