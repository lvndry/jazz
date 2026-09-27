/**
 * @fileoverview A conversation's reminder file, read and rewritten by the bridge.
 *
 * The agent writes reminders itself through `add_reminder`, one JSON file per agent under
 * `<home>/reminders`. The bridge reads the same file to list reminders, cancels from a button,
 * and sweeps due ones. It does that as root inside a directory the conversation's uid owns,
 * so every access goes through a pinned directory (`sandbox-fs.ts`): a `reminders` directory
 * or a reminder file swapped for a link to another conversation's is treated as empty rather
 * than read, and a rewrite replaces the name instead of writing through it.
 *
 * Writes take the same lock the agent's `ReminderServiceImpl` takes, so a sweep never races
 * the agent adding one, and the rewritten file goes back to the conversation's uid. The file is
 * read and written in the agent's own versioned format (`REMINDER_FILE_KIND`); a file that is
 * corrupt or from a newer Jazz reads as empty and is never rewritten here, so its reminders are
 * not lost (the agent's own service quarantines a corrupt one on its next access).
 */

import { NodeFileSystem } from "@effect/platform-node";
import {
  REMINDER_FILE_KIND,
  REMINDER_STORE,
  reminderFileName,
  reminderLockName,
} from "@jazz/adapters/reminder-service";
import {
  claimInList,
  finishClaim,
  markClaimed,
  settleInList,
} from "@jazz/adapters/storage/scheduled-items";
import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { decodeStateFile, encodeStateFile } from "@jazz/core/utils/state-file";
import { withLock } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { openDirectory, type Ownership, type PinnedDirectory } from "./sandbox-fs";

const REMINDERS_DIRECTORY = "reminders";

/** A mode for reminder files in the bridge's own data directory. */
const DEFAULT_FILE_MODE = 0o640;

function openReminders(home: string): PinnedDirectory | undefined {
  try {
    const root = openDirectory(home);
    try {
      return root.directory(REMINDERS_DIRECTORY);
    } finally {
      root.close();
    }
  } catch {
    return undefined;
  }
}

type ReminderFileRead =
  | { readonly writable: true; readonly reminders: ReminderRecord[] }
  | { readonly writable: false; readonly reminders: readonly [] };

function parseReminders(raw: string | undefined, fileName: string): ReminderFileRead {
  if (raw === undefined) {
    return { writable: true, reminders: [] };
  }
  const decoded = decodeStateFile(raw, fileName, REMINDER_FILE_KIND);
  if (decoded.status === "ok") {
    return { writable: true, reminders: decoded.content };
  }
  console.error(
    `[jazz] ${fileName} is left untouched: ${decoded.status === "newer" ? decoded.error.message : decoded.reason}`,
  );
  return { writable: false, reminders: [] };
}

/** Agent ids with a reminder file in `home`, for a sweep over a shared directory. */
export function reminderAgentIds(home: string): string[] {
  const reminders = openReminders(home);
  if (reminders === undefined) {
    return [];
  }
  try {
    return reminders
      .list()
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => name.slice(0, -".json".length));
  } finally {
    reminders.close();
  }
}

/** The agent's reminders, for display. Empty when there are none or the file is not a file. */
export function readReminders(home: string, agentId: string): ReminderRecord[] {
  const reminders = openReminders(home);
  if (reminders === undefined) {
    return [];
  }
  try {
    const fileName = reminderFileName(agentId);
    return [...parseReminders(reminders.readText(fileName), fileName).reminders];
  } finally {
    reminders.close();
  }
}

/**
 * Rewrite the agent's reminder file under its lock: `update` returns the list to store (or
 * undefined to leave the file as it is) and a result. A file that is corrupt or from a newer
 * Jazz is never passed to `update`; `unreadable` is returned instead.
 */
async function rewriteReminders<Result>(
  home: string,
  agentId: string,
  ownership: Ownership | undefined,
  update: (reminders: readonly ReminderRecord[]) => {
    readonly next: readonly ReminderRecord[] | undefined;
    readonly result: Result;
  },
  unreadable: Result,
): Promise<Result> {
  const reminders = openReminders(home);
  if (reminders === undefined) {
    return unreadable;
  }
  try {
    const fileName = reminderFileName(agentId);
    const operation = Effect.sync(() => {
      const current = parseReminders(reminders.readText(fileName), fileName);
      if (!current.writable) {
        return unreadable;
      }
      const { next, result } = update(current.reminders);
      if (next !== undefined) {
        reminders.writeBytes(fileName, encodeStateFile(REMINDER_FILE_KIND, [...next]), {
          owner: ownership?.owner,
          mode: ownership?.fileMode ?? DEFAULT_FILE_MODE,
        });
      }
      return result;
    });
    return await Effect.runPromise(
      withLock(reminders.entry(reminderLockName(agentId)), operation).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  } finally {
    reminders.close();
  }
}

/** Remove one reminder by id. Resolves whether it was there. */
export function cancelReminder(
  home: string,
  agentId: string,
  reminderId: string,
  ownership: Ownership | undefined,
): Promise<boolean> {
  return rewriteReminders(
    home,
    agentId,
    ownership,
    (reminders) => {
      const found = reminders.some((reminder) => reminder.id === reminderId);
      return {
        next: found ? reminders.filter((reminder) => reminder.id !== reminderId) : undefined,
        result: found,
      };
    },
    false,
  );
}

/**
 * Claim every reminder due at `now` for delivery (see `scheduled-items.ts`): each is stamped
 * as being delivered by this process and stays in the file until {@link settleReminder}
 * records the outcome.
 */
export async function claimDueReminders(
  home: string,
  agentId: string,
  now: number,
  ownership: Ownership | undefined,
): Promise<readonly ReminderRecord[]> {
  const claimed = await rewriteReminders(
    home,
    agentId,
    ownership,
    (reminders) => {
      const claim = claimInList(REMINDER_STORE, agentId, reminders, now, (reminder) => {
        return reminder.fireAt <= now;
      });
      return {
        next: claim.claimed.length > 0 ? claim.next : undefined,
        result: claim.claimed,
      };
    },
    [] as ReminderRecord[],
  );
  markClaimed(REMINDER_STORE, agentId, claimed);
  return claimed;
}

/**
 * Record how a claimed reminder's send ended and release the claim: removed once sent, kept
 * with the error (and retried with backoff) when the send failed.
 */
export async function settleReminder(
  home: string,
  agentId: string,
  reminderId: string,
  outcome: DeliveryOutcome,
  ownership: Ownership | undefined,
): Promise<void> {
  try {
    await rewriteReminders(
      home,
      agentId,
      ownership,
      (reminders) => {
        const { next, found } = settleInList(reminders, reminderId, outcome, Date.now());
        return { next: found ? next : undefined, result: undefined };
      },
      undefined,
    );
  } finally {
    finishClaim(REMINDER_STORE, agentId, reminderId);
  }
}
