/**
 * Per-chat timezone support.
 *
 * Telegram never sends the sender's timezone, so each chat's zone is resolved
 * from (in order): an explicit `/tz` choice, one auto-detected from a shared
 * location, the container's `TZ`, then UTC. Everything time-related — reminder
 * parsing, clock times, confirmations — runs against the resolved zone so
 * "next friday at 2pm" means 2pm where the sender is.
 *
 * The resolution and storage logic is shared with the Discord bridge via
 * `@jazz/bot-shared/timezone-store`; only the store filename is bridge-specific.
 */

import {
  formatWhen,
  hasChatTz as hasChatTzShared,
  isValidTimeZone,
  setTzForChat as setTzForChatShared,
  tzForChat as tzForChatShared,
} from "@jazz/bot-shared/timezone-store";

export { formatWhen, isValidTimeZone };

const TZ_FILE = "tg-tz.json";

export function hasChatTz(dataDir: string, chatId: number): boolean {
  return hasChatTzShared(dataDir, TZ_FILE, chatId);
}

export function tzForChat(dataDir: string, chatId: number): string {
  return tzForChatShared(dataDir, TZ_FILE, chatId);
}

export function setTzForChat(dataDir: string, chatId: number, tz: string): string | undefined {
  return setTzForChatShared(dataDir, TZ_FILE, chatId, tz);
}
