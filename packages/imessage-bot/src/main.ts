/**
 * Script entry point for the iMessage bridge.
 *
 * Separate from `bridge.ts` so that module can be imported without starting
 * anything — `jazz imessage` loads it to call `startBridge` itself, and a
 * module that ran a bridge as a side effect of being imported could not be
 * loaded to read anything else out of it.
 */

import { toError } from "@jazz/core/utils/storage";
import { startBridge } from "./bridge";

void startBridge().catch((error: unknown) => {
  console.error(toError(error).message);
  process.exit(1);
});
