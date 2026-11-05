/**
 * @fileoverview Schedules the offloaded tool-result sweep for a bridge: the bridge's own data
 * directory and every per-conversation sandbox home under it.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_TOOL_RESULT_RETENTION_DAYS,
  scheduleToolResultSweep,
  TOOL_RESULT_SWEEP_INTERVAL_MS,
} from "@jazz/adapters/tool-result-retention";
import { listChatSandboxes } from "./chat-sandbox";

function configuredRetentionDays(dataDir: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
    const history = (parsed as { history?: { toolResultRetentionDays?: unknown } }).history;
    const days = history?.toolResultRetentionDays;
    return typeof days === "number" && Number.isInteger(days) && days >= 0
      ? days
      : DEFAULT_TOOL_RESULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_TOOL_RESULT_RETENTION_DAYS;
  }
}

export function startToolResultSweep(dataDir: string): void {
  scheduleToolResultSweep({
    jazzHomes: [dataDir, ...listChatSandboxes(dataDir).map((sandbox) => sandbox.home)],
    retentionDays: () => configuredRetentionDays(dataDir),
    repeatEveryMs: TOOL_RESULT_SWEEP_INTERVAL_MS,
    logger: {
      debug: (message, fields) => console.debug(`[tool-result-sweep] ${message}`, fields ?? {}),
      warn: (message, fields) => console.warn(`[tool-result-sweep] ${message}`, fields ?? {}),
    },
  });
}
