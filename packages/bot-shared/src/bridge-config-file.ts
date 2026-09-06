/**
 * @fileoverview Applying the bridge-managed config keys to a file on disk.
 *
 * Split from the pure merge rule in `bridge-config.ts` and from the entrypoint
 * script that shells out to it, because two callers need the same file-level
 * behaviour: the entrypoint seeding the shared `config.json`, and the
 * per-chat sandbox seeding one config per chat home.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type JsonObject, mergeBridgeConfig } from "./bridge-config";

function readExistingConfig(path: string): JsonObject {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Refuse rather than overwrite: an operator who hand-edited this into
    // invalid JSON would otherwise lose it with no trace.
    throw new Error(`${path} is not valid JSON; refusing to overwrite it. Fix or remove it.`);
  }
  // An array or scalar is not a config; treat it as absent rather than
  // spreading it into one.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

/**
 * Merge the bridge-managed keys into the config at `path`, creating it when absent.
 *
 * @returns The managed keys that were applied, for logging.
 */
export function applyBridgeConfigFile(path: string): readonly string[] {
  // Ollama unloads a model after 5 minutes by default, so the first message after a
  // quiet spell pays a full cold load — minutes on a CPU-bound host, emitting no
  // events while it happens.
  const { config, applied } = mergeBridgeConfig(readExistingConfig(path), {
    braveApiKey: process.env["BRAVE_API_KEY"]?.trim(),
    ollamaKeepAlive: process.env["JAZZ_OLLAMA_KEEP_ALIVE"]?.trim(),
  });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return applied;
}
