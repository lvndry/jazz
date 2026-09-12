/**
 * Script entry point for the Photon bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything - `jazz imessage` loads it to call `startBridge` itself.
 */

import { startBridge } from "./bridge";

void startBridge().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
