/**
 * @fileoverview Apply the bridge-managed keys to a bridge's `config.json`.
 *
 * Merged rather than written wholesale: the data volume outlives the container, so
 * anything the operator added by hand must survive a restart.
 *
 * Usage: bun write-bridge-config.ts <path-to-config.json>
 */

import { applyBridgeConfigFile } from "./bridge-config-file";

const configPath = process.argv[2];
if (configPath === undefined) {
  console.error("write-bridge-config: expected a config.json path");
  process.exit(1);
}

let applied: readonly string[];
try {
  applied = applyBridgeConfigFile(configPath);
} catch (error) {
  console.error(`write-bridge-config: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(
  applied.length > 0
    ? `Merged into ${configPath}: ${applied.join(", ")} (other keys preserved)`
    : `No bridge-managed keys set; left other keys in ${configPath} untouched`,
);
