/**
 * Per-conversation timezone support, shared by the Discord and Telegram bridges.
 *
 * Neither platform reliably sends the sender's timezone, so each conversation's
 * zone is resolved from (in order): an explicit `/tz` choice, the container's
 * `TZ`, then UTC. Everything time-related — reminder parsing, clock times,
 * confirmations — runs against the resolved zone so "next friday at 2pm" means
 * 2pm where the sender is.
 *
 * `fileName` is the per-bridge store file (`dc-tz.json` / `tg-tz.json`); each
 * bridge's own `timezone.ts` bakes that in so call sites don't repeat it.
 */

import { recordStorePath, readRecordStore, writeRecordStore } from "./scoped-record-store";

export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when this conversation has an explicitly stored, valid zone (vs. falling back). */
export function hasChatTz(dataDir: string, fileName: string, scopeId: string | number): boolean {
  const stored = readRecordStore<string>(recordStorePath(dataDir, fileName))?.[String(scopeId)];
  return typeof stored === "string" && isValidTimeZone(stored);
}

export function tzForChat(dataDir: string, fileName: string, scopeId: string | number): string {
  const stored = readRecordStore<string>(recordStorePath(dataDir, fileName))?.[String(scopeId)];
  if (typeof stored === "string" && isValidTimeZone(stored)) return stored;
  const fromEnv = process.env["TZ"]?.trim() ?? "";
  return isValidTimeZone(fromEnv) ? fromEnv : "UTC";
}

/** Persist an explicit zone for a conversation. Returns the previously stored value. */
export function setTzForChat(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
  tz: string,
): string | undefined {
  const path = recordStorePath(dataDir, fileName);
  const store = readRecordStore<string>(path) ?? {};
  const key = String(scopeId);
  const previous = store[key];
  store[key] = tz;
  writeRecordStore(path, store);
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
