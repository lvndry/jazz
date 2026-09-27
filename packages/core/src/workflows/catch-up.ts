/**
 * Decides which scheduled workflows missed a run while Jazz wasn't running,
 * and re-runs them on startup within a configurable max-age window.
 */
import cronParser from "cron-parser";
import { Effect } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { DEFAULT_MAX_CATCH_UP_AGE_SECONDS } from "@/core/constants/agent";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { deliverWorkflowResult, notifyWorkflowNotRun } from "@/core/notify/workflow-delivery";
import { normalizeCronExpression } from "@/core/utils/cron";
import { toError } from "@/core/utils/errors";
import {
  lastCompletedRunAt,
  loadRunHistory,
  markInterruptedRuns,
  type NewWorkflowRunRecord,
  recordRunsUnderLock,
  runScheduleKey,
  runScheduleLabel,
  updateRunRecord,
  type WorkflowRunRecord,
} from "@/core/workflows/run-history";
import {
  scheduleId,
  SchedulerServiceTag,
  type ScheduledWorkflow,
} from "@/core/workflows/scheduler-service";
import { WorkflowServiceTag, type WorkflowMetadata } from "@/core/workflows/workflow-service";
import { renderWorkflowPrompt } from "@/core/workflows/workflow-utils";

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
  /** Status of the latest run; used to treat recent "running" as already handling catch-up. */
  readonly lastRunStatus?: WorkflowRunRecord["status"];
}

/**
 * Latest run per schedule id. Keyed by `<workflow>/<label>` rather than by workflow,
 * because a weekly run satisfying the monthly slot would silently skip the monthly recap.
 */
function getLastRunSnapshot(
  history: readonly WorkflowRunRecord[],
): Map<string, WorkflowRunSnapshot> {
  const map = new Map<string, WorkflowRunSnapshot>();

  for (const record of history) {
    const timestamp = record.completedAt ?? record.startedAt;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) continue;

    const key = `${record.workflowName}/${runScheduleLabel(record)}`;
    const existing = map.get(key);
    if (!existing || !existing.lastRunAt || parsed.getTime() > existing.lastRunAt.getTime()) {
      map.set(key, {
        workflowName: record.workflowName,
        lastRunAt: parsed,
        lastRunStatus: record.status,
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
  lastRunStatus?: WorkflowRunRecord["status"],
  ignoreCatchUpSetting = false,
): CatchUpDecision {
  if (!workflow.schedule) {
    return { shouldRun: false, reason: "missing schedule" };
  }

  if (!ignoreCatchUpSetting && workflow.catchUpOnRestart !== true) {
    return { shouldRun: false, reason: "catch-up disabled" };
  }

  const scheduledAt = getMostRecentScheduledTime(workflow.schedule, now);
  if (!scheduledAt) {
    return { shouldRun: false, reason: "invalid schedule" };
  }

  const maxAgeSeconds =
    typeof workflow.maxCatchUpAge === "number" && workflow.maxCatchUpAge > 0
      ? workflow.maxCatchUpAge
      : DEFAULT_MAX_CATCH_UP_AGE_SECONDS;

  if (lastRunAt && lastRunAt.getTime() >= scheduledAt.getTime()) {
    return { shouldRun: false, reason: "already ran" };
  }

  // A "running" record started within the catch-up window means the user already
  // triggered catch-up (or it completed but the record was never updated). Don't re-prompt.
  if (
    lastRunStatus === "running" &&
    lastRunAt &&
    Math.floor((now.getTime() - lastRunAt.getTime()) / 1000) <= maxAgeSeconds
  ) {
    return { shouldRun: false, reason: "already ran" };
  }

  const ageSeconds = Math.floor((now.getTime() - scheduledAt.getTime()) / 1000);

  if (ageSeconds > maxAgeSeconds) {
    return { shouldRun: false, reason: "missed window", scheduledAt };
  }

  return { shouldRun: true, reason: "missed run", scheduledAt };
}

function formatAgentRunId(entry: ScheduledWorkflow, now: Date): string {
  return `workflow-${entry.workflowName}-${entry.label}-catchup-${now.getTime()}`;
}

/**
 * Returns scheduled workflows that need catch-up (missed run, within max age, catch-up enabled),
 * after marking runs whose process died as `interrupted`. Does not verify agent or workflow
 * content availability.
 */
export function getCatchUpCandidates() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const workflowService = yield* WorkflowServiceTag;

    const scheduled = yield* scheduler
      .listScheduled()
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    if (scheduled.length === 0) {
      return [];
    }

    yield* markInterruptedRuns();
    const history = yield* loadRunHistory();
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();
    const candidates: CatchUpCandidate[] = [];

    for (const entry of scheduled) {
      const workflow = yield* workflowService
        .getWorkflow(entry.workflowName)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      if (!workflow) continue;

      const snapshot = lastRunMap.get(scheduleId(entry));
      const decision = decideCatchUp(
        { ...workflow, schedule: entry.schedule },
        snapshot?.lastRunAt,
        now,
        snapshot?.lastRunStatus,
      );

      if (decision.shouldRun) {
        candidates.push({ entry, workflow, decision });
      }
    }

    return candidates;
  });
}

/** A scheduled slot this process claimed: its `running` record is already in the history. */
export interface ClaimedWorkflowRun {
  readonly entry: ScheduledWorkflow;
  readonly workflow: WorkflowMetadata;
  readonly record: WorkflowRunRecord;
  /** The history as it was when the slot was claimed, for the prompt's "last run" marker. */
  readonly history: readonly WorkflowRunRecord[];
}

interface ClaimWorkflowRunsOptions {
  /** Let the in-process scheduler run workflows that opt out of startup catch-up. */
  readonly ignoreCatchUpSetting?: boolean;
}

function describeMissedWindow(scheduledAt: Date | undefined): string {
  const when = scheduledAt === undefined ? "a scheduled slot" : scheduledAt.toISOString();
  return `Missed ${when} by more than its catch-up window, so it was not run.`;
}

/**
 * Decide which of `entries` are due and record their runs, in one step under the run-history
 * lock, so two processes (two daemons, or a daemon and a CLI starting up) cannot both run the
 * same slot. A slot missed by more than its catch-up window gets a `skipped` record instead,
 * once, so the history shows it. Entries whose workflow cannot be found are left out.
 */
export function claimWorkflowRuns(
  entries: readonly ScheduledWorkflow[],
  options: ClaimWorkflowRunsOptions = {},
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const known: Array<{ readonly entry: ScheduledWorkflow; readonly workflow: WorkflowMetadata }> =
      [];
    for (const entry of entries) {
      const workflow = yield* workflowService
        .getWorkflow(entry.workflowName)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      if (workflow === undefined) {
        yield* logger.warn("Catch-up skipped: workflow not found", {
          workflow: entry.workflowName,
        });
        continue;
      }
      known.push({ entry, workflow });
    }
    if (known.length === 0) {
      return [] as ClaimedWorkflowRun[];
    }

    const now = new Date();
    let historyAtClaim: readonly WorkflowRunRecord[] = [];
    const added = yield* recordRunsUnderLock((history) => {
      historyAtClaim = history;
      const lastRunMap = getLastRunSnapshot(history);
      const records: NewWorkflowRunRecord[] = [];
      for (const { entry, workflow } of known) {
        const snapshot = lastRunMap.get(scheduleId(entry));
        const decision = decideCatchUp(
          { ...workflow, schedule: entry.schedule },
          snapshot?.lastRunAt,
          now,
          snapshot?.lastRunStatus,
          options.ignoreCatchUpSetting === true,
        );
        if (decision.shouldRun) {
          records.push({
            workflowName: entry.workflowName,
            scheduleLabel: entry.label,
            startedAt: now.toISOString(),
            status: "running",
            triggeredBy: "scheduled",
          });
        } else if (decision.reason === "missed window") {
          records.push({
            workflowName: entry.workflowName,
            scheduleLabel: entry.label,
            startedAt: (decision.scheduledAt ?? now).toISOString(),
            completedAt: now.toISOString(),
            status: "skipped",
            error: describeMissedWindow(decision.scheduledAt),
            triggeredBy: "scheduled",
          });
        }
      }
      return records;
    }, now);

    const claims: ClaimedWorkflowRun[] = [];
    for (const record of added) {
      if (record.status === "skipped") {
        yield* logger.info("Scheduled workflow slot skipped", {
          schedule: runScheduleKey(record),
          reason: "missed window",
        });
        continue;
      }
      const match = known.find(({ entry }) => scheduleId(entry) === runScheduleKey(record));
      if (match !== undefined) {
        claims.push({ ...match, record, history: historyAtClaim });
      }
    }
    return claims;
  });
}

/**
 * Run one claimed slot and finish its record (by id) as completed or failed. Failures are
 * recorded and logged, never raised, so one workflow cannot stop the others.
 */
export function runClaimedWorkflow(claim: ClaimedWorkflowRun) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const notifications = (yield* (yield* AgentConfigServiceTag).appConfig).notifications;
    const { entry, workflow, record } = claim;
    const notifyNotRun = (error: string) =>
      notifyWorkflowNotRun({
        notifications,
        workflow: entry.workflowName,
        deliver: workflow.deliver,
        agentId: entry.agent,
        error,
      });
    const finish = (update: Parameters<typeof updateRunRecord>[1]) =>
      updateRunRecord(record.id, { completedAt: new Date().toISOString(), ...update }).pipe(
        Effect.catchAll((error) =>
          logger.warn("Workflow run record could not be updated", {
            workflow: entry.workflowName,
            error: toError(error).message,
          }),
        ),
      );

    const agentResult = yield* getAgentByIdentifier(entry.agent).pipe(Effect.either);
    if (agentResult._tag === "Left") {
      yield* logger.warn("Catch-up skipped: agent not found", {
        workflow: entry.workflowName,
        agent: entry.agent,
      });
      yield* finish({ status: "failed", error: `Agent '${entry.agent}' not found.` });
      yield* notifyNotRun(`Agent '${entry.agent}' not found.`);
      return;
    }

    const workflowContent = yield* workflowService
      .loadWorkflow(entry.workflowName)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (!workflowContent) {
      yield* logger.warn("Catch-up skipped: workflow content not available", {
        workflow: entry.workflowName,
      });
      yield* finish({ status: "failed", error: "Workflow content is not available." });
      yield* notifyNotRun("Workflow content is not available.");
      return;
    }

    yield* logger.info("Running workflow catch-up", {
      schedule: scheduleId(entry),
      agent: entry.agent,
    });

    const autoApprovePolicy = workflow.autoApprove ?? true;
    const prompt = renderWorkflowPrompt(workflowContent.prompt, {
      label: entry.label,
      cron: entry.schedule,
      lastRunAt: lastCompletedRunAt(claim.history, entry.workflowName, entry.label),
      startedAt: record.startedAt,
    });

    yield* AgentRunner.run({
      agent: agentResult.right,
      userInput: prompt,
      conversationId: formatAgentRunId(entry, new Date(record.startedAt)),
      pinInitialMessage: true,
      ...(workflow.maxIterations != null ? { maxIterations: workflow.maxIterations } : {}),
      ...(workflow.maxCostUSD != null ? { maxCostUSD: workflow.maxCostUSD } : {}),
      ...(workflow.maxTokens != null ? { maxTokens: workflow.maxTokens } : {}),
      ...(workflow.maxDurationMs != null ? { maxDurationMs: workflow.maxDurationMs } : {}),
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      origin: {
        source: "workflow",
        name: entry.workflowName,
        ...(workflow.deliver !== undefined ? { deliverTo: workflow.deliver } : {}),
      },
    }).pipe(
      Effect.tap(() => finish({ status: "completed" })),
      Effect.tap((response) =>
        deliverWorkflowResult({
          notifications,
          workflow: entry.workflowName,
          deliver: workflow.deliver,
          agentId: agentResult.right.id,
          answer: response.content,
        }),
      ),
      Effect.tapError((error) => finish({ status: "failed", error: toError(error).message })),
      Effect.catchAll((error) =>
        logger.warn("Catch-up run failed", {
          workflow: entry.workflowName,
          error: toError(error).message,
        }),
      ),
    );
  });
}

/**
 * Claim and run catch-up for the given scheduled workflow entries, one after another. Each
 * slot is re-decided under the history lock first, so a slot another process already ran is
 * not run again.
 */
export function runCatchUpForWorkflows(entries: readonly ScheduledWorkflow[]) {
  if (entries.length === 0) {
    return Effect.void;
  }
  return claimWorkflowRuns(entries).pipe(
    Effect.flatMap((claims) => Effect.forEach(claims, runClaimedWorkflow, { discard: true })),
    Effect.catchAll(() => Effect.void),
  );
}

/**
 * Claim the most recent due slot of every scheduled workflow, for the daemon's in-process
 * ticker to run. Unlike restart catch-up, this is the scheduler itself, so `catchUpOnRestart`
 * does not disable it. The claim is the `running` record, so the same slot is not claimed
 * again on the next tick.
 */
export function claimInProcessScheduledWorkflows() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const scheduled = yield* scheduler
      .listScheduled()
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    if (scheduled.length === 0) {
      return [] as ClaimedWorkflowRun[];
    }
    return yield* claimWorkflowRuns(scheduled, { ignoreCatchUpSetting: true });
  });
}
