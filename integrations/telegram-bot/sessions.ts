/**
 * Per-chat conversation sessions.
 *
 * A DM has one chat id, so history would grow forever. A per-chat "epoch" lets
 * /new rotate to a fresh conversation key (a breakpoint) while the chat's agent
 * — and thus its model/persona — stays put. Old segments remain on disk.
 * `dataDir` is Jazz's home.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sessionsPath(dataDir: string): string {
  return join(dataDir, "tg-sessions.json");
}

/** Parse the epoch map; returns null when the file is missing or unreadable. */
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

/** Conversation key for the chat's current session (epoch 0 keeps the raw id). */
export function conversationKey(dataDir: string, chatId: number): string {
  const epoch = loadSessionEpochs(dataDir)?.[String(chatId)] ?? 0;
  return epoch > 0 ? `${chatId}-${epoch}` : String(chatId);
}

/** Bump the chat's session epoch so the next run starts a fresh conversation. */
export function startNewConversation(dataDir: string, chatId: number): void {
  const path = sessionsPath(dataDir);
  const epochs = loadSessionEpochs(dataDir);
  if (epochs === null && existsSync(path)) {
    // File exists but couldn't be parsed — preserve it rather than clobber
    // every other chat's epoch on the write below.
    try {
      renameSync(path, `${path}.corrupt`);
      console.error(`Corrupt ${path} preserved as ${path}.corrupt`);
    } catch {
      // best effort
    }
  }
  const next = epochs ?? {};
  next[String(chatId)] = (next[String(chatId)] ?? 0) + 1;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}
