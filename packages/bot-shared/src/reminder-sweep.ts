/**
 * @fileoverview Fire reminders that have come due, on any surface.
 *
 * The agent schedules these itself through the `add_reminder` tool, which
 * writes one JSON file per agent under its own Jazz home. Nothing delivers
 * them: a reminder only becomes a message because a bridge process sweeps for
 * due ones on an interval, which is what this does.
 *
 * Delivery is at least once: a reminder is removed only after its message went out,
 * so a platform that is down for a sweep gets it on the next one. A reminder for a
 * conversation this bridge cannot address is left alone for the bridge that can.
 *
 * The Telegram and Discord bridges each carried a copy differing in two lines —
 * how an agent id decodes back to a conversation, and how the text is marked up.
 * Both are injected here, so a new surface gets reminders by supplying those.
 */

import {
  chatIsolationEnabled,
  ensureChatSandbox,
  listChatSandboxes,
  sandboxOwnership,
} from "./chat-sandbox";
import { acknowledgeReminders, dueReminders, reminderAgentIds } from "./reminder-store";
import type { Ownership } from "./sandbox-fs";
import { bold, type ChatId, line, plainLine, type RichText, text } from "./surface";

export const REMINDER_SWEEP_MS = 20_000;

/**
 * How late a reminder can be before it is announced as delayed.
 *
 * The sweep interval alone accounts for up to `REMINDER_SWEEP_MS` of lateness
 * on a healthy bridge, so this sits well above it: past this the delay is a
 * restart or a stall, which is worth telling the person about because it
 * changes whether the reminder still makes sense.
 */
const DELAYED_THRESHOLD_MS = 90_000;

export interface ReminderSweepOptions {
  readonly dataDir: string;
  /**
   * Recover the conversation an agent id belongs to, or undefined when the id
   * is not one of this surface's. Several bridges can share a data directory,
   * and one must not deliver another's reminders into a chat id that happens
   * to parse.
   */
  readonly decodeScope: (agentId: string) => ChatId | undefined;
  readonly send: (chatId: ChatId, body: RichText) => Promise<unknown>;
}

let sweepRunning = false;

/** One Jazz home to sweep, and which agents' reminder files in it to look at. */
interface SweepTarget {
  readonly home: string;
  readonly agentIds: readonly string[];
  readonly ownership: Ownership | undefined;
}

/**
 * Every home a reminder file could be in.
 *
 * With per-conversation sandboxes each one writes reminders inside its own Jazz
 * home, so there is no single `reminders/` left to scan — but the sweep runs in
 * the bridge process, which is the identity that can read across all of them.
 * A sandbox is only ever swept for its own agent: a file named after another
 * conversation's agent in it is one that conversation did not write.
 */
function sweepTargets(dataDir: string): SweepTarget[] {
  if (!chatIsolationEnabled()) {
    return [{ home: dataDir, agentIds: reminderAgentIds(dataDir), ownership: undefined }];
  }
  return listChatSandboxes(dataDir).map(({ agentId }) => {
    const sandbox = ensureChatSandbox(dataDir, agentId);
    return { home: sandbox.home, agentIds: [agentId], ownership: sandboxOwnership(sandbox) };
  });
}

function reminderBody(reminderText: string, late: boolean): RichText {
  return [
    line(bold("⏰ Reminder"), ...(late ? [text(" (delayed)")] : [])),
    plainLine(reminderText),
  ];
}

/** One sweep: deliver what is due now. Exported for tests; the bridge uses the interval. */
export async function sweepRemindersOnce(options: ReminderSweepOptions): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const now = Date.now();
    for (const target of sweepTargets(options.dataDir)) {
      for (const agentId of target.agentIds) {
        // Checked before anything is taken: another bridge sharing this data
        // directory owns the reminders this one cannot address.
        const chatId = options.decodeScope(agentId);
        if (chatId === undefined) continue;
        // Delivered first and removed after, one at a time: a send that fails leaves that
        // reminder for the next sweep, and the ones after it still go out.
        for (const reminder of dueReminders(target.home, agentId, now)) {
          try {
            await options.send(
              chatId,
              reminderBody(reminder.text, now - reminder.fireAt > DELAYED_THRESHOLD_MS),
            );
          } catch (error) {
            console.error(
              `Could not deliver reminder ${reminder.id} to ${chatId}: ${String(error)}`,
            );
            continue;
          }
          await acknowledgeReminders(target.home, agentId, [reminder.id], target.ownership);
        }
      }
    }
  } finally {
    sweepRunning = false;
  }
}

export function startReminderSweep(options: ReminderSweepOptions): void {
  const sweep = (): void => {
    void sweepRemindersOnce(options).catch((error) =>
      console.error(`Reminder sweep failed: ${String(error)}`),
    );
  };
  // Deliver anything that came due while the bridge was down before waiting out
  // a first interval.
  sweep();
  setInterval(sweep, REMINDER_SWEEP_MS);
}
