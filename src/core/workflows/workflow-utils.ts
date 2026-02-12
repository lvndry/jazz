import { describeCronSchedule } from "@/core/utils/cron-utils";
import type { WorkflowMetadata } from "./workflow-service";

/**
 * Group workflows by their location (Local, Global, Built-in).
 */
export function groupWorkflows(workflows: readonly WorkflowMetadata[]) {
  const local: WorkflowMetadata[] = [];
  const global: WorkflowMetadata[] = [];
  const builtin: WorkflowMetadata[] = [];

  const cwd = process.cwd();
  const homeDir = process.env["HOME"] || "";

  for (const workflow of workflows) {
    if (workflow.path.startsWith(cwd)) {
      local.push(workflow);
    } else if (workflow.path.includes(".jazz/workflows") && workflow.path.startsWith(homeDir)) {
      global.push(workflow);
    } else {
      builtin.push(workflow);
    }
  }

  return { local, global, builtin };
}

/**
 * Format a single workflow for display in lists.
 */
export function formatWorkflow(
  w: WorkflowMetadata,
  options?: {
    statusBadge?: string;
  },
): string {
  const scheduleDesc = w.schedule ? describeCronSchedule(w.schedule) : null;
  const scheduleStr = w.schedule ? (scheduleDesc ? ` (${scheduleDesc})` : ` [${w.schedule}]`) : "";
  const agent = w.agent ? ` (agent: ${w.agent})` : "";
  const status = options?.statusBadge ?? "";
  return `  ${w.name}${scheduleStr}${agent}${status}\n    ${w.description}`;
}
