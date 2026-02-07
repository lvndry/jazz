import { describeCronSchedule } from "@/core/utils/cron-utils";
import type { GrooveMetadata } from "./groove-service";

/**
 * Group grooves by their location (Local, Global, Built-in).
 */
export function groupGrooves(grooves: readonly GrooveMetadata[]) {
  const local: GrooveMetadata[] = [];
  const global: GrooveMetadata[] = [];
  const builtin: GrooveMetadata[] = [];

  const cwd = process.cwd();
  const homeDir = process.env["HOME"] || "";

  for (const groove of grooves) {
    if (groove.path.startsWith(cwd)) {
      local.push(groove);
    } else if (
      groove.path.includes(".jazz/grooves") &&
      groove.path.startsWith(homeDir)
    ) {
      global.push(groove);
    } else {
      builtin.push(groove);
    }
  }

  return { local, global, builtin };
}

/**
 * Format a single groove for display in lists.
 */
export function formatGroove(
  w: GrooveMetadata,
  options?: {
    statusBadge?: string;
  },
): string {
  const scheduleDesc = w.schedule ? describeCronSchedule(w.schedule) : null;
  const scheduleStr = w.schedule
    ? scheduleDesc
      ? ` (${scheduleDesc})`
      : ` [${w.schedule}]`
    : "";
  const agent = w.agent ? ` (agent: ${w.agent})` : "";
  const status = options?.statusBadge ?? "";
  return `  ${w.name}${scheduleStr}${agent}${status}\n    ${w.description}`;
}
