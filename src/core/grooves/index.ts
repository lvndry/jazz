/**
 * Groove management and scheduling module.
 *
 * This module provides:
 * - GrooveService: Discovery and loading of groove definitions
 * - SchedulerService: System scheduler integration (launchd/cron)
 * - Run history tracking
 * - Catch-up logic for missed scheduled runs
 */

// Groove service
export {
  GrooveServiceTag,
  GroovesLive,
  type GrooveService,
  type GrooveMetadata,
  type GrooveContent,
} from "./groove-service";

// Scheduler service
export {
  SchedulerServiceTag,
  SchedulerServiceLayer,
  type SchedulerService,
  type ScheduledGroove,
} from "./scheduler-service";

// Run history
export {
  loadRunHistory,
  addRunRecord,
  updateLatestRunRecord,
  getGrooveHistory,
  getRecentRuns,
  type GrooveRunRecord,
} from "./run-history";

// Catch-up
export {
  runGrooveCatchUp,
  runCatchUpForGrooves,
  getCatchUpCandidates,
  decideCatchUp,
  type CatchUpDecision,
  type CatchUpCandidate,
} from "./catch-up";
