/**
 * Script entry point for the Photon bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything - `jazz imessage` loads it to call `startBridge` itself.
 */

import { toError } from "@jazz/core/utils/storage";
import { startBridge } from "./bridge";

void startBridge().catch((error: unknown) => {
  console.error(toError(error).message);
  process.exit(1);
});
