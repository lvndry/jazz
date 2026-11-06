/**
 * Script entry point for the WhatsApp bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything — `jazz whatsapp` loads it to call `startBridge` itself.
 */

import { getLogsDirectory } from "@jazz/adapters/logger";
import { installCrashHandlers } from "@jazz/core/utils/crash-report";
import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

installCrashHandlers({ role: "whatsapp-bot", logsDirectory: getLogsDirectory() });

void startBridge().catch((error: unknown) => {
  console.error(toError(error).message);
  process.exit(1);
});
