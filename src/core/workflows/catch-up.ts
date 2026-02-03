import cronParser from "cron-parser";
import { Effect } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { addRunRecord, loadRunHistory, updateLatestRunRecord } from "@/core/workflows/run-history";
import { SchedulerServiceTag } from "@/core/workflows/scheduler-service";
import { WorkflowServiceTag, type WorkflowMetadata } from "@/core/workflows/workflow-service";

export interface CatchUpDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
  readonly scheduledAt?: Date;
}

interface WorkflowRunSnapshot {
  readonly workflowName: string;
  readonly lastRunAt?: Date;
}

const DEFAULT_MAX_CATCH_UP_AGE_SECONDS = 60 * 60 * 24;

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

function normalizeCronExpression(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    return `0 ${schedule}`;
  }
  return schedule;
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

export function runWorkflowCatchUp() {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const scheduler = yield* SchedulerServiceTag;
    const workflowService = yield* WorkflowServiceTag;

    const scheduled = yield* scheduler.listScheduled().pipe(Effect.catchAll(() => Effect.succeed([])));
    if (scheduled.length === 0) {
      return;
    }

    const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();

    for (const entry of scheduled) {
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

      yield* AgentRunner.run({
        agent: agentResult.right,
        userInput: workflowContent.prompt,
        sessionId: runId,
        conversationId: runId,
        maxIterations: 50,
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
