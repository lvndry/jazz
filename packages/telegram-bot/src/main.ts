/**
 * Script entry point for the Telegram bridge.
 *
 * Separate from `bridge.ts` so that module can be imported (by its tests) without starting
 * anything.
 */

import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

void startBridge().catch((error: unknown) => {
  console.error(`Bridge failed to start: ${toError(error).message}`);
  process.exit(1);
});
