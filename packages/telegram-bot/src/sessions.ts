/**
 * Per-chat conversation sessions.
 *
 * A DM has one chat id, so history would grow forever. A per-chat "epoch" lets
 * /new rotate to a fresh conversation key (a breakpoint) while the chat's agent
 * — and thus its model/persona — stays put. Old segments remain on disk. The
 * epoch and incognito storage logic is shared with the Discord bridge via
 * `@jazz/bot-shared/session-store`; only the store filenames are bridge-specific.
 */

import {
  conversationKey as conversationKeyShared,
  isIncognito as isIncognitoShared,
  setIncognito as setIncognitoShared,
  startNewConversation as startNewConversationShared,
} from "@jazz/bot-shared/session-store";

const EPOCHS_FILE = "tg-sessions.json";
const INCOGNITO_FILE = "tg-incognito.json";

export function conversationKey(dataDir: string, chatId: number): string {
  return conversationKeyShared(dataDir, EPOCHS_FILE, chatId);
}

export function startNewConversation(dataDir: string, chatId: number): void {
  startNewConversationShared(dataDir, EPOCHS_FILE, chatId);
}

export function isIncognito(dataDir: string, chatId: number): boolean {
  return isIncognitoShared(dataDir, INCOGNITO_FILE, chatId);
}

export function setIncognito(dataDir: string, chatId: number, value: boolean): void {
  setIncognitoShared(dataDir, INCOGNITO_FILE, chatId, value);
}
