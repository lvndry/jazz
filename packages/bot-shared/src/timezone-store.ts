/**
 * Per-conversation timezone support, shared by the Discord, Telegram, iMessage and WhatsApp
 * bridges.
 *
 * No platform reliably sends the sender's timezone, so a conversation's zone is what the user
 * chose with `/tz` (or shared a location for), then the operator's explicit
 * `JAZZ_BOT_DEFAULT_TIMEZONE`. The server's own zone is never used: it says nothing about the
 * user. A conversation with neither has no zone, and the agent asks for it.
 *
 * `fileName` is the per-bridge store file (`dc-tz.json` / `tg-tz.json`); each
 * bridge's own `timezone.ts` bakes that in so call sites don't repeat it.
 */

import {
  isValidTimeZone,
  parseTimeZone,
  type UserZoneSource,
} from "@jazz/core/utils/user-time-zone";
import { recordStorePath, readRecordStore, writeRecordStore } from "./scoped-record-store";

export { isValidTimeZone };

/** Environment variable naming the zone for conversations that have not set their own. */
export const BOT_DEFAULT_TIMEZONE_ENV = "JAZZ_BOT_DEFAULT_TIMEZONE";

/** A conversation's zone and where it came from. */
export interface ChatZone {
  readonly zone: string;
  readonly source: Extract<UserZoneSource, "chat-setting" | "operator-default">;
}

function storedZone(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
): string | undefined {
  const stored = readRecordStore<string>(recordStorePath(dataDir, fileName))?.[String(scopeId)];
  if (typeof stored !== "string") {
    return undefined;
  }
  const parsed = parseTimeZone(stored);
  return parsed.ok ? parsed.zone : undefined;
}

/** True when this conversation has an explicitly stored, valid zone. */
export function hasChatTz(dataDir: string, fileName: string, scopeId: string | number): boolean {
  return storedZone(dataDir, fileName, scopeId) !== undefined;
}

let warnedDefault: string | undefined;

/** The zone for a conversation: its stored choice, else the operator's configured default. */
export function chatZone(
  dataDir: string,
  fileName: string,
  scopeId: string | number,
  environment: NodeJS.ProcessEnv = process.env,
): ChatZone | undefined {
  const stored = storedZone(dataDir, fileName, scopeId);
  if (stored !== undefined) {
    return { zone: stored, source: "chat-setting" };
  }
  const configured = environment[BOT_DEFAULT_TIMEZONE_ENV]?.trim() ?? "";
  const parsed = configured.length > 0 ? parseTimeZone(configured) : undefined;
  if (parsed?.ok === false && warnedDefault !== configured) {
    warnedDefault = configured;
    console.warn(
      "[timezone] JAZZ_BOT_DEFAULT_TIMEZONE is invalid; use an IANA region name or UTC. Chats without a saved zone will be asked.",
    );
  }
  return parsed?.ok === true ? { zone: parsed.zone, source: "operator-default" } : undefined;
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
