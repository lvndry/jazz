/**
 * Per-channel conversation sessions.
 *
 * A DM has one channel id, so history would grow forever. A per-channel "epoch"
 * lets /new rotate to a fresh conversation key while the channel's agent — and
 * thus its model/persona — stays put. Old segments remain on disk. The epoch
 * and incognito storage logic is shared with the Telegram bridge via
 * `@jazz/bot-shared/session-store`; only the store filenames are bridge-specific.
 */

import {
  conversationKey as conversationKeyShared,
  isIncognito as isIncognitoShared,
  setIncognito as setIncognitoShared,
  startNewConversation as startNewConversationShared,
} from "@jazz/bot-shared/session-store";

const EPOCHS_FILE = "dc-sessions.json";
const INCOGNITO_FILE = "dc-incognito.json";

export function conversationKey(dataDir: string, channelId: string): string {
  return conversationKeyShared(dataDir, EPOCHS_FILE, channelId);
}

export function startNewConversation(dataDir: string, channelId: string): void {
  startNewConversationShared(dataDir, EPOCHS_FILE, channelId);
}

export function isIncognito(dataDir: string, channelId: string): boolean {
  return isIncognitoShared(dataDir, INCOGNITO_FILE, channelId);
}

export function setIncognito(dataDir: string, channelId: string, value: boolean): void {
  setIncognitoShared(dataDir, INCOGNITO_FILE, channelId, value);
}
