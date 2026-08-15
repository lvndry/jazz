/**
 * Per-channel conversation sessions.
 *
 * A DM has one channel id, so history would grow forever. A per-channel "epoch"
 * lets /new rotate to a fresh conversation key while the channel's agent — and
 * thus its model/persona — stays put. Old segments remain on disk.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sessionsPath(dataDir: string): string {
  return join(dataDir, "dc-sessions.json");
}

function loadSessionEpochs(dataDir: string): Record<string, number> | null {
  const path = sessionsPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // fall through to null (treated as unreadable)
  }
  return null;
}

export function conversationKey(dataDir: string, channelId: string): string {
  const epoch = loadSessionEpochs(dataDir)?.[channelId] ?? 0;
  return epoch > 0 ? `${channelId}-${epoch}` : channelId;
}

export function startNewConversation(dataDir: string, channelId: string): void {
  const path = sessionsPath(dataDir);
  const epochs = loadSessionEpochs(dataDir);
  if (epochs === null && existsSync(path)) {
    try {
      renameSync(path, `${path}.corrupt`);
      console.error(`Corrupt ${path} preserved as ${path}.corrupt`);
    } catch {
      // best effort
    }
  }
  const next = epochs ?? {};
  next[channelId] = (next[channelId] ?? 0) + 1;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

function incognitoPath(dataDir: string): string {
  return join(dataDir, "dc-incognito.json");
}

function loadIncognitoChats(dataDir: string): Record<string, boolean> | null {
  const path = incognitoPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // fall through to null (treated as unreadable)
  }
  return null;
}

export function isIncognito(dataDir: string, channelId: string): boolean {
  return loadIncognitoChats(dataDir)?.[channelId] === true;
}

export function setIncognito(dataDir: string, channelId: string, value: boolean): void {
  const path = incognitoPath(dataDir);
  const chats = loadIncognitoChats(dataDir);
  if (chats === null && existsSync(path)) {
    try {
      renameSync(path, `${path}.corrupt`);
      console.error(`Corrupt ${path} preserved as ${path}.corrupt`);
    } catch {
      // best effort
    }
  }
  const next = chats ?? {};
  if (value) {
    next[channelId] = true;
  } else {
    delete next[channelId];
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}
