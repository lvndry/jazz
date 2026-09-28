/**
 * Script entry point for the Discord bridge.
 *
 * Separate from `bridge.ts` so that module can be imported (by its tests) without starting
 * anything.
 */

import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

try {
  startBridge();
} catch (error) {
  console.error(`Bridge failed to start: ${toError(error).message}`);
  process.exit(1);
}
