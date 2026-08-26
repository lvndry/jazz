/**
 * @fileoverview Apply the bridge-managed keys to a bridge's `config.json`.
 *
 * Merged rather than written wholesale: the data volume outlives the container, so
 * anything the operator added by hand must survive a restart.
 *
 * Usage: bun write-bridge-config.ts <path-to-config.json>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mergeBridgeConfig, type JsonObject } from "./bridge-config";

const configPath = process.argv[2];
if (configPath === undefined) {
  console.error("write-bridge-config: expected a config.json path");
  process.exit(1);
}

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
    console.error(
      `write-bridge-config: ${path} is not valid JSON; refusing to overwrite it. Fix or remove it.`,
    );
    process.exit(1);
  }
  // An array or scalar is not a config; treat it as absent rather than
  // spreading it into one.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

// Ollama unloads a model after 5 minutes by default, so the first message after a
// quiet spell pays a full cold load — minutes on a CPU-bound host, emitting no
// events while it happens.
const { config, applied } = mergeBridgeConfig(readExistingConfig(configPath), {
  braveApiKey: process.env["BRAVE_API_KEY"]?.trim(),
  ollamaKeepAlive: process.env["JAZZ_OLLAMA_KEEP_ALIVE"]?.trim(),
});

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  applied.length > 0
    ? `Merged into ${configPath}: ${applied.join(", ")} (other keys preserved)`
    : `No bridge-managed keys set; left other keys in ${configPath} untouched`,
);
