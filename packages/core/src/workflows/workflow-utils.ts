import { describeCronSchedule } from "@/core/utils/cron";
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

/**
 * Rewrite the `name:` line of a WORKFLOW.md's frontmatter, leaving every other
 * byte of the file as published. Used when a marketplace workflow is installed
 * under a different local name.
 */
export function renameWorkflowDefinition(markdown: string, name: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, (frontmatter) =>
    frontmatter.replace(/^name:.*$/m, `name: ${name}`),
  );
}

/** What a run knows about how it was started, exposed to the prompt as placeholders. */
export interface WorkflowRunContext {
  /** Schedule label that fired the run, or `manual`. */
  readonly label: string;
  /** Cron of that schedule; empty for a manual run. */
  readonly cron: string;
  /** When this workflow last completed under the same label; empty on the first run. */
  readonly lastRunAt: string | undefined;
  /** When this run started. */
  readonly startedAt: string;
}

/**
 * Fill the run-time placeholders a WORKFLOW.md body may use, so one definition can
 * serve several schedules: `{schedule.label}`, `{schedule.cron}`,
 * `{schedule.lastRunAt}`, and `{run.startedAt}`.
 */
export function renderWorkflowPrompt(prompt: string, context: WorkflowRunContext): string {
  return prompt
    .replaceAll("{schedule.label}", context.label)
    .replaceAll("{schedule.cron}", context.cron)
    .replaceAll("{schedule.lastRunAt}", context.lastRunAt ?? "")
    .replaceAll("{run.startedAt}", context.startedAt);
}
