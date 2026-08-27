/**
 * Per-channel timezone support.
 *
 * Discord never sends the sender's timezone, so each channel's zone is resolved
 * from (in order): an explicit `/tz` choice, the container's `TZ`, then UTC.
 * The resolution and storage logic is shared with the Telegram bridge via
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

const TZ_FILE = "dc-tz.json";

export function hasChatTz(dataDir: string, channelId: string): boolean {
  return hasChatTzShared(dataDir, TZ_FILE, channelId);
}

export function tzForChat(dataDir: string, channelId: string): string {
  return tzForChatShared(dataDir, TZ_FILE, channelId);
}

export function setTzForChat(dataDir: string, channelId: string, tz: string): string | undefined {
  return setTzForChatShared(dataDir, TZ_FILE, channelId, tz);
}
