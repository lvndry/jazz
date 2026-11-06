/**
 * @fileoverview Schedules the offloaded tool-result sweep for a bridge: the bridge's own data
 * directory and every per-conversation sandbox home under it.
 */

import * as path from "node:path";
import {
  scheduleToolResultSweep,
  TOOL_RESULT_SWEEP_INTERVAL_MS,
} from "@jazz/adapters/tool-result-retention";
import { readRetentionDaysFromFile } from "@jazz/adapters/tool-result-retention-policy";
import { iterateChatSandboxHomes } from "./chat-sandbox";

export function startToolResultSweep(dataDir: string): void {
  scheduleToolResultSweep({
    jazzHomes: async function* () {
      yield dataDir;
      yield* iterateChatSandboxHomes(dataDir);
    },
    retentionDays: () => readRetentionDaysFromFile(path.join(dataDir, "config.json")),
    repeatEveryMs: TOOL_RESULT_SWEEP_INTERVAL_MS,
    logger: {
      debug: (message, fields) => console.debug(`[tool-result-sweep] ${message}`, fields ?? {}),
      warn: (message, fields) => console.warn(`[tool-result-sweep] ${message}`, fields ?? {}),
    },
  });
}
