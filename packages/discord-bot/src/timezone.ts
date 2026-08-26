/**
 * Per-channel timezone support.
 *
 * Discord never sends the sender's timezone, so each channel's zone is resolved
 * from (in order): an explicit `/tz` choice, the container's `TZ`, then UTC.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function tzStorePath(dataDir: string): string {
  return join(dataDir, "dc-tz.json");
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

export function hasChatTz(dataDir: string, channelId: string): boolean {
  const stored = readTzStore(dataDir)[channelId];
  return typeof stored === "string" && isValidTimeZone(stored);
}

export function tzForChat(dataDir: string, channelId: string): string {
  const stored = readTzStore(dataDir)[channelId];
  if (typeof stored === "string" && isValidTimeZone(stored)) return stored;
  const fromEnv = process.env["TZ"]?.trim() ?? "";
  return isValidTimeZone(fromEnv) ? fromEnv : "UTC";
}

export function setTzForChat(dataDir: string, channelId: string, tz: string): string | undefined {
  const store = readTzStore(dataDir);
  const previous = store[channelId];
  store[channelId] = tz;
  writeTzStore(dataDir, store);
  return previous;
}

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
