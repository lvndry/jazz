/**
 * Script entry point for the WhatsApp bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything — `jazz whatsapp` loads it to call `startBridge` itself.
 */

import { toError } from "@jazz/core/utils/errors";
import { startBridge } from "./bridge";

void startBridge().catch((error: unknown) => {
  console.error(toError(error).message);
  process.exit(1);
});
