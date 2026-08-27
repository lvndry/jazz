/**
 * Corrupt-tolerant JSON record files, shared by the small per-conversation
 * stores (session epochs, incognito flags, timezones, daily usage) that both
 * bridges keep under `<dataDir>/<prefix>-<name>.json`.
 *
 * Every one of those stores is "a flat `Record<scopeId, V>` written back on
 * every mutation" — this module is that one file-I/O primitive so each store
 * only has to define its own value shape and merge rule.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function recordStorePath(dataDir: string, fileName: string): string {
  return join(dataDir, fileName);
}

/** Reads the store. Returns `{}` when the file is absent, `null` when it exists but won't parse. */
export function readRecordStore<V>(path: string): Record<string, V> | null {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, V>;
    }
  } catch {
    // fall through to null
  }
  return null;
}

export function writeRecordStore<V>(path: string, value: Record<string, V>): void {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write ${path}: ${String(error)}`);
  }
}

/**
 * Preserve a file that failed to parse as `<path>.corrupt` instead of letting
 * the next write silently overwrite it — used by stores where clobbering the
 * file would also wipe every other conversation's entry, not just the one
 * being written.
 */
export function preserveCorruptFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    renameSync(path, `${path}.corrupt`);
    console.error(`Corrupt ${path} preserved as ${path}.corrupt`);
  } catch {
    // best effort
  }
}
