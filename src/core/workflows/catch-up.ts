import cronParser from "cron-parser";
import { Effect } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { DEFAULT_MAX_CATCH_UP_AGE_SECONDS } from "@/core/constants/agent";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { HeadlessPresentationServiceLayer } from "@/core/presentation/headless-presentation-service";
import { normalizeCronExpression } from "@/core/utils/cron-utils";
import { addRunRecord, loadRunHistory, updateLatestRunRecord } from "@/core/workflows/run-history";
import {
  SchedulerServiceTag,
  type ScheduledWorkflow,
} from "@/core/workflows/scheduler-service";
import { WorkflowServiceTag, type WorkflowMetadata } from "@/core/workflows/workflow-service";

export interface CatchUpDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
  readonly scheduledAt?: Date;
}

/**
 * A scheduled workflow that needs catch-up (decision.shouldRun is true).
 */
export interface CatchUpCandidate {
  readonly entry: ScheduledWorkflow;
  readonly workflow: WorkflowMetadata;
  readonly decision: CatchUpDecision;
}

interface WorkflowRunSnapshot {
  readonly workflowName: string;
  readonly lastRunAt?: Date;
}

function getLastRunSnapshot(history: readonly { workflowName: string; startedAt: string; completedAt?: string }[]): Map<string, WorkflowRunSnapshot> {
  const map = new Map<string, WorkflowRunSnapshot>();

  for (const record of history) {
    const timestamp = record.completedAt ?? record.startedAt;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) continue;

    const existing = map.get(record.workflowName);
    if (!existing || !existing.lastRunAt || parsed.getTime() > existing.lastRunAt.getTime()) {
      map.set(record.workflowName, {
        workflowName: record.workflowName,
        lastRunAt: parsed,
      });
    }
  }

  return map;
}

function getMostRecentScheduledTime(schedule: string, now: Date): Date | undefined {
  try {
    const normalized = normalizeCronExpression(schedule);
    const interval = cronParser.parse(normalized, { currentDate: now });
    return interval.prev().toDate();
  } catch {
    return undefined;
  }
}

export function decideCatchUp(
  workflow: WorkflowMetadata,
  lastRunAt: Date | undefined,
  now: Date,
): CatchUpDecision {
  if (!workflow.schedule) {
    return { shouldRun: false, reason: "missing schedule" };
  }

  if (workflow.catchUpOnStartup !== true) {
    return { shouldRun: false, reason: "catch-up disabled" };
  }

  const scheduledAt = getMostRecentScheduledTime(workflow.schedule, now);
  if (!scheduledAt) {
    return { shouldRun: false, reason: "invalid schedule" };
  }

  if (lastRunAt && lastRunAt.getTime() >= scheduledAt.getTime()) {
    return { shouldRun: false, reason: "already ran" };
  }

  const maxAgeSeconds =
    typeof workflow.maxCatchUpAge === "number" && workflow.maxCatchUpAge > 0
      ? workflow.maxCatchUpAge
      : DEFAULT_MAX_CATCH_UP_AGE_SECONDS;
  const ageSeconds = Math.floor((now.getTime() - scheduledAt.getTime()) / 1000);

  if (ageSeconds > maxAgeSeconds) {
    return { shouldRun: false, reason: "missed window", scheduledAt };
  }

  return { shouldRun: true, reason: "missed run", scheduledAt };
}

function formatAgentRunId(workflowName: string, now: Date): string {
  return `workflow-${workflowName}-catchup-${now.getTime()}`;
}

/**
 * Returns scheduled workflows that need catch-up (missed run, within max age, catch-up enabled).
 * Does not verify agent or workflow content availability.
 */
export function getCatchUpCandidates() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const workflowService = yield* WorkflowServiceTag;

    const scheduled = yield* scheduler.listScheduled().pipe(Effect.catchAll(() => Effect.succeed([])));
    if (scheduled.length === 0) {
      return [];
    }

    const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();
    const candidates: CatchUpCandidate[] = [];

    for (const entry of scheduled) {
      const workflow = yield* workflowService.getWorkflow(entry.workflowName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      if (!workflow) continue;

      const lastRunAt = lastRunMap.get(entry.workflowName)?.lastRunAt;
      const decision = decideCatchUp(workflow, lastRunAt, now);

      if (decision.shouldRun) {
        candidates.push({ entry, workflow, decision });
      }
    }

    return candidates;
  });
}

/**
 * Run catch-up for the given scheduled workflow entries only.
 * Skips entries where agent or workflow content is unavailable (logs a warning).
 */
export function runCatchUpForWorkflows(entries: readonly ScheduledWorkflow[]) {
  if (entries.length === 0) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();

    for (const entry of entries) {
      const workflow = yield* workflowService.getWorkflow(entry.workflowName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      if (!workflow) {
        yield* logger.warn("Catch-up skipped: workflow not found", {
          workflow: entry.workflowName,
        });
        continue;
      }

      const lastRunAt = lastRunMap.get(entry.workflowName)?.lastRunAt;
      const decision = decideCatchUp(workflow, lastRunAt, now);

      if (!decision.shouldRun) {
        yield* logger.debug("Catch-up skipped: no longer needed", {
          workflow: entry.workflowName,
          reason: decision.reason,
        });
        continue;
      }

      const agentResult = yield* getAgentByIdentifier(entry.agent).pipe(Effect.either);
      if (agentResult._tag === "Left") {
        yield* logger.warn("Catch-up skipped: agent not found", {
          workflow: entry.workflowName,
          agent: entry.agent,
        });
        continue;
      }

      const workflowContent = yield* workflowService.loadWorkflow(entry.workflowName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (!workflowContent) {
        yield* logger.warn("Catch-up skipped: workflow content not available", {
          workflow: entry.workflowName,
        });
        continue;
      }

      yield* logger.info("Running workflow catch-up", {
        workflow: entry.workflowName,
        scheduledAt: decision.scheduledAt?.toISOString(),
        agent: entry.agent,
      });

      const startedAt = new Date().toISOString();
      yield* addRunRecord({
        workflowName: entry.workflowName,
        startedAt,
        status: "running",
        triggeredBy: "scheduled",
      }).pipe(Effect.catchAll(() => Effect.void));

      const autoApprovePolicy = workflow.autoApprove ?? true;
      const runId = formatAgentRunId(entry.workflowName, now);
      const maxIterations = workflow.maxIterations ?? 50;

      yield* AgentRunner.run({
        agent: agentResult.right,
        userInput: workflowContent.prompt,
        sessionId: runId,
        conversationId: runId,
        maxIterations,
        ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      }).pipe(
        Effect.tap(() =>
          updateLatestRunRecord(entry.workflowName, {
            completedAt: new Date().toISOString(),
            status: "completed",
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.tapError((error) =>
          updateLatestRunRecord(entry.workflowName, {
            completedAt: new Date().toISOString(),
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          logger.warn("Catch-up run failed", {
            workflow: entry.workflowName,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
  }).pipe(Effect.catchAll(() => Effect.void));
}

export function runWorkflowCatchUp() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const scheduled = yield* scheduler.listScheduled().pipe(Effect.catchAll(() => Effect.succeed([])));
    yield* runCatchUpForWorkflows(scheduled);
  }).pipe(Effect.catchAll(() => Effect.void));
}

function formatMissedTime(scheduledAt: Date | undefined): string {
  if (!scheduledAt) return "unknown time";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const scheduledDay = new Date(scheduledAt.getFullYear(), scheduledAt.getMonth(), scheduledAt.getDate());

  const timeStr = scheduledAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (scheduledDay.getTime() === today.getTime()) {
    return `missed ${timeStr} today`;
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (scheduledDay.getTime() === yesterday.getTime()) {
    return `missed ${timeStr} yesterday`;
  }

  return `missed ${scheduledAt.toLocaleDateString()} ${timeStr}`;
}

/**
 * Interactive catch-up prompt shown when Jazz starts.
 *
 * If there are workflows that need catch-up:
 * 1. Notifies the user about pending catch-ups
 * 2. Asks if they want to catch them up (y/n)
 * 3. If yes, lets them select which workflows to run
 * 4. Runs selected workflows in the background
 *
 * Returns immediately after starting background tasks so the original command can continue.
 * In non-TTY mode (scripts, CI), skips the prompt and does nothing.
 */
export function promptInteractiveCatchUp() {
  return Effect.gen(function* () {
    // Skip in non-interactive environments
    if (!process.stdout.isTTY) {
      return;
    }

    const candidates = yield* getCatchUpCandidates().pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly CatchUpCandidate[])),
    );

    if (candidates.length === 0) {
      return;
    }

    const terminal = yield* TerminalServiceTag;
    const logger = yield* LoggerServiceTag;

    // Show notification about pending catch-ups
    yield* terminal.log("");
    yield* terminal.warn(
      `${candidates.length} workflow${candidates.length > 1 ? "s" : ""} need${candidates.length === 1 ? "s" : ""} to catch up:`,
    );

    for (const candidate of candidates) {
      const missedStr = formatMissedTime(candidate.decision.scheduledAt);
      yield* terminal.log(`   • ${candidate.entry.workflowName} (${missedStr})`);
    }

    yield* terminal.log("");

    // Ask if user wants to catch up
    const wantsCatchUp = yield* terminal.confirm("Would you like to catch them up?", false);

    if (!wantsCatchUp) {
      yield* terminal.log("");
      return;
    }

    // Let user select which workflows to run
    const choices = candidates.map((c) => ({
      name: `${c.entry.workflowName} (${formatMissedTime(c.decision.scheduledAt)})`,
      value: c.entry.workflowName,
    }));

    // Pre-select all by default
    const defaultSelected = candidates.map((c) => c.entry.workflowName);

    yield* terminal.log("");
    const selected = yield* terminal.checkbox<string>(
      "Select workflows to catch up (Space to toggle, Enter to confirm):",
      { choices, default: defaultSelected },
    );

    if (selected.length === 0) {
      yield* terminal.info("No workflows selected.");
      yield* terminal.log("");
      return;
    }

    const entriesToRun = candidates
      .filter((c) => selected.includes(c.entry.workflowName))
      .map((c) => c.entry);

    yield* terminal.log("");
    yield* terminal.info(`Running ${entriesToRun.length} workflow${entriesToRun.length > 1 ? "s" : ""} in background...`);
    yield* terminal.log("");

    // Fork the catch-up execution so it runs in the background.
    // Use headless presentation so "pilot is thinking" and tool output don't overwrite the main UI.
    yield* Effect.fork(
      runCatchUpForWorkflows(entriesToRun).pipe(
        Effect.provide(HeadlessPresentationServiceLayer),
        Effect.tap(() =>
          logger.info("Background catch-up completed", {
            workflows: entriesToRun.map((e) => e.workflowName),
          }),
        ),
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.void));
}
