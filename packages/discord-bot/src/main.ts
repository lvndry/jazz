/**
 * Script entry point for the Discord bridge.
 *
 * Separate from `bridge.ts` so that module can be imported (by its tests) without starting
 * anything.
 */

import { getLogsDirectory } from "@jazz/adapters/logger";
import { installCrashHandlers } from "@jazz/core/utils/crash-report";
import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

installCrashHandlers({ role: "discord-bot", logsDirectory: getLogsDirectory() });

try {
  startBridge();
} catch (error) {
  console.error(`Bridge failed to start: ${toError(error).message}`);
  process.exit(1);
}
