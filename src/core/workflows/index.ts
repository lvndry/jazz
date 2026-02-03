/**
 * Workflow management and scheduling module.
 *
 * This module provides:
 * - WorkflowService: Discovery and loading of workflow definitions
 * - SchedulerService: System scheduler integration (launchd/cron)
 * - Run history tracking
 * - Catch-up logic for missed scheduled runs
 */

// Workflow service
export {
  WorkflowServiceTag,
  WorkflowsLive,
  type WorkflowService,
  type WorkflowMetadata,
  type WorkflowContent,
} from "./workflow-service";

// Scheduler service
export {
  SchedulerServiceTag,
  SchedulerServiceLayer,
  type SchedulerService,
  type ScheduledWorkflow,
} from "./scheduler-service";

// Run history
export {
  loadRunHistory,
  addRunRecord,
  updateLatestRunRecord,
  getWorkflowHistory,
  getRecentRuns,
  type WorkflowRunRecord,
} from "./run-history";

// Catch-up
export { runWorkflowCatchUp, decideCatchUp, type CatchUpDecision } from "./catch-up";
