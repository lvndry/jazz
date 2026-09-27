/**
 * @fileoverview Fire reminders that have come due, on any surface.
 *
 * The agent schedules these itself through the `add_reminder` tool, which
 * writes one JSON file per agent under its own Jazz home. Nothing delivers
 * them: a reminder only becomes a message because a bridge process sweeps for
 * due ones on an interval, which is what this does.
 *
 * The Telegram and Discord bridges each carried a copy differing in two lines —
 * how an agent id decodes back to a conversation, and how the text is marked up.
 * Both are injected here, so a new surface gets reminders by supplying those.
 */

import { join } from "node:path";
import { claimDueReminders, settleReminder } from "@jazz/adapters/reminder-service";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { Effect } from "effect";
import { listChatSandboxes } from "./chat-sandbox";
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
export const DELAYED_THRESHOLD_MS = 90_000;

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

/**
 * One surface's side of delivering a reminder: which of the agent ids it owns, and how a
 * reminder reaches the conversation behind one.
 */
export interface ReminderDelivery<Scope> {
  readonly dataDir: string;
  /** The conversation an agent id belongs to, or undefined when the id is not this surface's. */
  readonly decodeScope: (agentId: string) => Scope | undefined;
  /** Send one reminder; `late` says it is past {@link DELAYED_THRESHOLD_MS}. Throws on failure. */
  readonly deliver: (scope: Scope, reminderText: string, late: boolean) => Promise<unknown>;
}

/**
 * Deliver every due reminder this surface owns, once.
 *
 * Each reminder is claimed under its agent's lock before it is sent and removed only after the
 * send succeeded. A failed send keeps it on disk with the error, to be retried with backoff,
 * and does not stop the rest of the sweep. A reminder whose agent id this surface cannot map to
 * a conversation (right now) is never claimed, so it waits instead of being dropped: a surface
 * that rebuilds its id map after a restart delivers it on a later sweep.
 */
export async function deliverDueReminders<Scope>(options: ReminderDelivery<Scope>): Promise<void> {
  const now = Date.now();
  for (const root of remindersRootDirs(options.dataDir)) {
    const claims = await Effect.runPromise(
      claimDueReminders(root, now, {
        includeAgent: (agentId) => options.decodeScope(agentId) !== undefined,
      }),
    );
    for (const { agentId, item } of claims) {
      const scope = options.decodeScope(agentId);
      let outcome: DeliveryOutcome;
      if (scope === undefined) {
        outcome = {
          delivered: false,
          error: "The conversation for this reminder is unknown.",
          retryable: true,
        };
      } else {
        try {
          await options.deliver(scope, item.text, now - item.fireAt > DELAYED_THRESHOLD_MS);
          outcome = { delivered: true };
        } catch (error) {
          outcome = { delivered: false, error: String(error), retryable: true };
        }
      }
      await Effect.runPromise(
        settleReminder(root, agentId, item.id, outcome).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() =>
              console.error(`Reminder ${item.id} could not be settled: ${error.message}`),
            ),
          ),
        ),
      );
    }
  }
}

let sweepRunning = false;

/**
 * Every directory a reminder file could be in.
 *
 * With per-conversation sandboxes each one writes reminders inside its own Jazz
 * home, so there is no single `reminders/` left to scan — but the sweep runs in
 * the bridge process, which is the identity that can read across all of them.
 */
function remindersRootDirs(dataDir: string): string[] {
  const homes = listChatSandboxes(dataDir).map((sandbox) => sandbox.home);
  return (homes.length > 0 ? homes : [dataDir]).map((home) => join(home, "reminders"));
}

function reminderBody(reminderText: string, late: boolean): RichText {
  return [
    line(bold("⏰ Reminder"), ...(late ? [text(" (delayed)")] : [])),
    plainLine(reminderText),
  ];
}

async function fireDueReminders(options: ReminderSweepOptions): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await deliverDueReminders({
      dataDir: options.dataDir,
      decodeScope: options.decodeScope,
      deliver: (chatId, reminderText, late) =>
        options.send(chatId, reminderBody(reminderText, late)),
    });
  } finally {
    sweepRunning = false;
  }
}

export function startReminderSweep(options: ReminderSweepOptions): void {
  const sweep = (): void => {
    void fireDueReminders(options).catch((error) =>
      console.error(`Reminder sweep failed: ${String(error)}`),
    );
  };
  // Deliver anything that came due while the bridge was down before waiting out
  // a first interval.
  sweep();
  setInterval(sweep, REMINDER_SWEEP_MS);
}
