/**
 * Per-conversation session state, shared by the Discord and Telegram bridges.
 *
 * A DM/chat has one id, so history would grow forever. A per-conversation
 * "epoch" lets /new rotate to a fresh conversation key (a breakpoint) while
 * the conversation's agent — and thus its model/persona — stays put. Old
 * segments remain on disk.
 *
 * `/incognito` marks a conversation as private: runs for it use `jazz run
 * --ephemeral` (no history/memory persistence) until /new is typed. Only this
 * on/off flag lives on disk here — never the conversation content itself.
 *
 * `epochsFileName`/`incognitoFileName` are the per-bridge store files
 * (`dc-sessions.json`/`tg-sessions.json`, `dc-incognito.json`/`tg-incognito.json`);
 * each bridge's own `sessions.ts` bakes those in so call sites don't repeat them.
 */

import {
  preserveCorruptFile,
  readRecordStore,
  recordStorePath,
  writeRecordStore,
} from "./scoped-record-store";

/** Conversation key for the conversation's current session (epoch 0 keeps the raw id). */
export function conversationKey(
  dataDir: string,
  epochsFileName: string,
  scopeId: string | number,
): string {
  const epoch =
    readRecordStore<number>(recordStorePath(dataDir, epochsFileName))?.[String(scopeId)] ?? 0;
  return epoch > 0 ? `${scopeId}-${epoch}` : String(scopeId);
}

/** Bump the conversation's session epoch so the next run starts a fresh conversation. */
export function startNewConversation(
  dataDir: string,
  epochsFileName: string,
  scopeId: string | number,
): void {
  const path = recordStorePath(dataDir, epochsFileName);
  const epochs = readRecordStore<number>(path);
  if (epochs === null) {
    // File exists but couldn't be parsed — preserve it rather than clobber
    // every other conversation's epoch on the write below.
    preserveCorruptFile(path);
  }
  const next = epochs ?? {};
  const key = String(scopeId);
  next[key] = (next[key] ?? 0) + 1;
  writeRecordStore(path, next);
}

export function isIncognito(
  dataDir: string,
  incognitoFileName: string,
  scopeId: string | number,
): boolean {
  return (
    readRecordStore<boolean>(recordStorePath(dataDir, incognitoFileName))?.[String(scopeId)] ===
    true
  );
}

export function setIncognito(
  dataDir: string,
  incognitoFileName: string,
  scopeId: string | number,
  value: boolean,
): void {
  const path = recordStorePath(dataDir, incognitoFileName);
  const current = readRecordStore<boolean>(path);
  if (current === null) {
    preserveCorruptFile(path);
  }
  const next = current ?? {};
  const key = String(scopeId);
  if (value) {
    next[key] = true;
  } else {
    delete next[key];
  }
  writeRecordStore(path, next);
}
