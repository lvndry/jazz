/**
 * Script entry point for the iMessage bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything — `jazz imessage` loads it to call `startBridge` itself, and a
 * module that ran a bridge as a side effect of being imported could not be
 * loaded to read anything else out of it.
 */

import { getLogsDirectory } from "@jazz/adapters/logger";
import { installCrashHandlers } from "@jazz/core/utils/crash-report";
import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

installCrashHandlers({ role: "imessage-bot", logsDirectory: getLogsDirectory() });

void startBridge().catch((error: unknown) => {
  console.error(toError(error).message);
  process.exit(1);
});
