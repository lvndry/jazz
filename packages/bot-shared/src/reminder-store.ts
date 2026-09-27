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
 * the agent adding one, and the rewritten file goes back to the conversation's uid.
 */

import { NodeFileSystem } from "@effect/platform-node";
import { reminderFileName, reminderLockName } from "@jazz/adapters/reminder-service";
import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
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

function parseReminders(raw: string | undefined): ReminderRecord[] {
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ReminderRecord[]) : [];
  } catch {
    return [];
  }
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
    return parseReminders(reminders.readText(reminderFileName(agentId)));
  } finally {
    reminders.close();
  }
}

/**
 * Rewrite the agent's reminder file under its lock: `select` splits it into what stays and
 * what goes, and what goes is returned.
 */
async function rewriteReminders(
  home: string,
  agentId: string,
  ownership: Ownership | undefined,
  select: (reminders: readonly ReminderRecord[]) => {
    readonly kept: readonly ReminderRecord[];
    readonly removed: readonly ReminderRecord[];
  },
): Promise<readonly ReminderRecord[]> {
  const reminders = openReminders(home);
  if (reminders === undefined) {
    return [];
  }
  try {
    const fileName = reminderFileName(agentId);
    const operation = Effect.sync(() => {
      const { kept, removed } = select(parseReminders(reminders.readText(fileName)));
      if (removed.length > 0) {
        reminders.writeBytes(fileName, `${JSON.stringify(kept, null, 2)}\n`, {
          owner: ownership?.owner,
          mode: ownership?.fileMode ?? DEFAULT_FILE_MODE,
        });
      }
      return removed;
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
export async function cancelReminder(
  home: string,
  agentId: string,
  reminderId: string,
  ownership: Ownership | undefined,
): Promise<boolean> {
  const removed = await rewriteReminders(home, agentId, ownership, (reminders) => ({
    kept: reminders.filter((reminder) => reminder.id !== reminderId),
    removed: reminders.filter((reminder) => reminder.id === reminderId),
  }));
  return removed.length > 0;
}

/** Remove and return every reminder due at `now`. */
export function takeDueReminders(
  home: string,
  agentId: string,
  now: number,
  ownership: Ownership | undefined,
): Promise<readonly ReminderRecord[]> {
  return rewriteReminders(home, agentId, ownership, (reminders) => ({
    kept: reminders.filter((reminder) => reminder.fireAt > now),
    removed: reminders.filter((reminder) => reminder.fireAt <= now),
  }));
}
