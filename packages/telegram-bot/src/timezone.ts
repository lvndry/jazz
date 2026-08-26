/**
 * Per-chat timezone support.
 *
 * Telegram never sends the sender's timezone, so each chat's zone is resolved
 * from (in order): an explicit `/tz` choice, one auto-detected from a shared
 * location, the container's `TZ`, then UTC. Everything time-related — reminder
 * parsing, clock times, confirmations — runs against the resolved zone so
 * "next friday at 2pm" means 2pm where the sender is.
 *
 * Store functions take the data directory (Jazz's home) rather than the bridge
 * config, so this module stays free of any dependency on bridge.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function tzStorePath(dataDir: string): string {
  return join(dataDir, "tg-tz.json");
}

function readTzStore(dataDir: string): Record<string, string> {
  try {
    const path = tzStorePath(dataDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore — treat as unset
  }
  return {};
}

function writeTzStore(dataDir: string, store: Record<string, string>): void {
  try {
    writeFileSync(tzStorePath(dataDir), `${JSON.stringify(store, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write timezone store: ${String(error)}`);
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when this chat has an explicitly stored, valid zone (vs. falling back). */
export function hasChatTz(dataDir: string, chatId: number): boolean {
  const stored = readTzStore(dataDir)[String(chatId)];
  return typeof stored === "string" && isValidTimeZone(stored);
}

/** Resolve the effective IANA zone for a chat, with fallbacks. */
export function tzForChat(dataDir: string, chatId: number): string {
  const stored = readTzStore(dataDir)[String(chatId)];
  if (typeof stored === "string" && isValidTimeZone(stored)) return stored;
  const fromEnv = process.env["TZ"]?.trim() ?? "";
  return isValidTimeZone(fromEnv) ? fromEnv : "UTC";
}

/** Persist an explicit zone for a chat. Returns the previously stored value. */
export function setTzForChat(dataDir: string, chatId: number, tz: string): string | undefined {
  const store = readTzStore(dataDir);
  const previous = store[String(chatId)];
  store[String(chatId)] = tz;
  writeTzStore(dataDir, store);
  return previous;
}

/** Format an instant for display in `tz` (e.g. "23 Sep 2026, 14:00"). */
export function formatWhen(fireAt: number, tz: string): string {
  try {
    return new Date(fireAt).toLocaleString("en-GB", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return `${new Date(fireAt).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}
