import cronParser from "cron-parser";
import { Effect } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { DEFAULT_MAX_CATCH_UP_AGE_SECONDS } from "@/core/constants/agent";
import { GrooveServiceTag, type GrooveMetadata } from "@/core/grooves/groove-service";
import { addRunRecord, loadRunHistory, updateLatestRunRecord } from "@/core/grooves/run-history";
import {
  SchedulerServiceTag,
  type ScheduledGroove,
} from "@/core/grooves/scheduler-service";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { HeadlessPresentationServiceLayer } from "@/core/presentation/headless-presentation-service";
import { normalizeCronExpression } from "@/core/utils/cron-utils";

export interface CatchUpDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
  readonly scheduledAt?: Date;
}

/**
 * A scheduled groove that needs catch-up (decision.shouldRun is true).
 */
export interface CatchUpCandidate {
  readonly entry: ScheduledGroove;
  readonly groove: GrooveMetadata;
  readonly decision: CatchUpDecision;
}

// Correction: The interface above had getGroove which is weird. Let's start with groove.
// Wait, in the code I used `groove`.

/**
 * A scheduled groove that needs catch-up (decision.shouldRun is true).
 */
export interface CatchUpCandidate {
  readonly entry: ScheduledGroove;
  readonly groove: GrooveMetadata;
  readonly decision: CatchUpDecision;
}

interface GrooveRunSnapshot {
  readonly grooveName: string;
  readonly lastRunAt?: Date;
}

function getLastRunSnapshot(history: readonly { grooveName: string; startedAt: string; completedAt?: string }[]): Map<string, GrooveRunSnapshot> {
  const map = new Map<string, GrooveRunSnapshot>();

  for (const record of history) {
    const timestamp = record.completedAt ?? record.startedAt;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) continue;

    const existing = map.get(record.grooveName);
    if (!existing || !existing.lastRunAt || parsed.getTime() > existing.lastRunAt.getTime()) {
      map.set(record.grooveName, {
        grooveName: record.grooveName,
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
  groove: GrooveMetadata,
  lastRunAt: Date | undefined,
  now: Date,
): CatchUpDecision {
  if (!groove.schedule) {
    return { shouldRun: false, reason: "missing schedule" };
  }

  if (groove.catchUpOnStartup !== true) {
    return { shouldRun: false, reason: "catch-up disabled" };
  }

  const scheduledAt = getMostRecentScheduledTime(groove.schedule, now);
  if (!scheduledAt) {
    return { shouldRun: false, reason: "invalid schedule" };
  }

  if (lastRunAt && lastRunAt.getTime() >= scheduledAt.getTime()) {
    return { shouldRun: false, reason: "already ran" };
  }

  const maxAgeSeconds =
    typeof groove.maxCatchUpAge === "number" && groove.maxCatchUpAge > 0
      ? groove.maxCatchUpAge
      : DEFAULT_MAX_CATCH_UP_AGE_SECONDS;
  const ageSeconds = Math.floor((now.getTime() - scheduledAt.getTime()) / 1000);

  if (ageSeconds > maxAgeSeconds) {
    return { shouldRun: false, reason: "missed window", scheduledAt };
  }

  return { shouldRun: true, reason: "missed run", scheduledAt };
}

function formatAgentRunId(grooveName: string, now: Date): string {
  return `groove-${grooveName}-catchup-${now.getTime()}`;
}

/**
 * Returns scheduled grooves that need catch-up (missed run, within max age, catch-up enabled).
 * Does not verify agent or groove content availability.
 */
export function getCatchUpCandidates() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const grooveService = yield* GrooveServiceTag;

    const scheduled = yield* scheduler.listScheduled().pipe(Effect.catchAll(() => Effect.succeed([])));
    if (scheduled.length === 0) {
      return [];
    }

    const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();
    const candidates: CatchUpCandidate[] = [];

    for (const entry of scheduled) {
      const groove = yield* grooveService.getGroove(entry.grooveName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      if (!groove) continue;

      const lastRunAt = lastRunMap.get(entry.grooveName)?.lastRunAt;
      const decision = decideCatchUp(groove, lastRunAt, now);

      if (decision.shouldRun) {
        candidates.push({ entry, groove, decision });
      }
    }

    return candidates;
  });
}

/**
 * Run catch-up for the given scheduled groove entries only.
 * Skips entries where agent or groove content is unavailable (logs a warning).
 */
export function runCatchUpForGrooves(entries: readonly ScheduledGroove[]) {
  if (entries.length === 0) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const grooveService = yield* GrooveServiceTag;
    const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
    const lastRunMap = getLastRunSnapshot(history);
    const now = new Date();

    for (const entry of entries) {
      const groove = yield* grooveService.getGroove(entry.grooveName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      if (!groove) {
        yield* logger.warn("Catch-up skipped: groove not found", {
          groove: entry.grooveName,
        });
        continue;
      }

      const lastRunAt = lastRunMap.get(entry.grooveName)?.lastRunAt;
      const decision = decideCatchUp(groove, lastRunAt, now);

      if (!decision.shouldRun) {
        yield* logger.debug("Catch-up skipped: no longer needed", {
          groove: entry.grooveName,
          reason: decision.reason,
        });
        continue;
      }

      const agentResult = yield* getAgentByIdentifier(entry.agent).pipe(Effect.either);
      if (agentResult._tag === "Left") {
        yield* logger.warn("Catch-up skipped: agent not found", {
          groove: entry.grooveName,
          agent: entry.agent,
        });
        continue;
      }

      const grooveContent = yield* grooveService.loadGroove(entry.grooveName).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (!grooveContent) {
        yield* logger.warn("Catch-up skipped: groove content not available", {
          groove: entry.grooveName,
        });
        continue;
      }

      yield* logger.info("Running groove catch-up", {
        groove: entry.grooveName,
        scheduledAt: decision.scheduledAt?.toISOString(),
        agent: entry.agent,
      });

      const startedAt = new Date().toISOString();
      yield* addRunRecord({
        grooveName: entry.grooveName,
        startedAt,
        status: "running",
        triggeredBy: "scheduled",
      }).pipe(Effect.catchAll(() => Effect.void));

      const autoApprovePolicy = groove.autoApprove ?? true;
      const runId = formatAgentRunId(entry.grooveName, now);
      const maxIterations = groove.maxIterations ?? 50;

      yield* AgentRunner.run({
        agent: agentResult.right,
        userInput: grooveContent.prompt,
        sessionId: runId,
        conversationId: runId,
        maxIterations,
        ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      }).pipe(
        Effect.tap(() =>
          updateLatestRunRecord(entry.grooveName, {
            completedAt: new Date().toISOString(),
            status: "completed",
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.tapError((error) =>
          updateLatestRunRecord(entry.grooveName, {
            completedAt: new Date().toISOString(),
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          logger.warn("Catch-up run failed", {
            groove: entry.grooveName,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
  }).pipe(Effect.catchAll(() => Effect.void));
}

export function runGrooveCatchUp() {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const scheduled = yield* scheduler.listScheduled().pipe(Effect.catchAll(() => Effect.succeed([])));
    yield* runCatchUpForGrooves(scheduled);
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
 * If there are grooves that need catch-up:
 * 1. Notifies the user about pending catch-ups
 * 2. Asks if they want to catch them up (y/n)
 * 3. If yes, lets them select which grooves to run
 * 4. Runs selected grooves in the background
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
      `${candidates.length} groove${candidates.length > 1 ? "s" : ""} need${candidates.length === 1 ? "s" : ""} to catch up:`,
    );

    for (const candidate of candidates) {
      const missedStr = formatMissedTime(candidate.decision.scheduledAt);
      yield* terminal.log(`   • ${candidate.entry.grooveName} (${missedStr})`);
    }

    yield* terminal.log("");

    // Ask if user wants to catch up
    const wantsCatchUp = yield* terminal.confirm("Would you like to catch them up?", false);

    if (!wantsCatchUp) {
      yield* terminal.log("");
      return;
    }

    // Let user select which grooves to run
    const choices = candidates.map((c) => ({
      name: `${c.entry.grooveName} (${formatMissedTime(c.decision.scheduledAt)})`,
      value: c.entry.grooveName,
    }));

    // Pre-select all by default
    const defaultSelected = candidates.map((c) => c.entry.grooveName);

    yield* terminal.log("");
    const selected = yield* terminal.checkbox<string>(
      "Select grooves to catch up (Space to toggle, Enter to confirm):",
      { choices, default: defaultSelected },
    );

    if (selected.length === 0) {
      yield* terminal.info("No grooves selected.");
      yield* terminal.log("");
      return;
    }

    const entriesToRun = candidates
      .filter((c) => selected.includes(c.entry.grooveName))
      .map((c) => c.entry);

    yield* terminal.log("");
    yield* terminal.info(`Running ${entriesToRun.length} groove${entriesToRun.length > 1 ? "s" : ""} in background...`);
    yield* terminal.log("");

    // Fork the catch-up execution so it runs in the background.
    // Use headless presentation so "pilot is thinking" and tool output don't overwrite the main UI.
    yield* Effect.fork(
      runCatchUpForGrooves(entriesToRun).pipe(
        Effect.provide(HeadlessPresentationServiceLayer),
        Effect.tap(() =>
          logger.info("Background catch-up completed", {
            grooves: entriesToRun.map((e) => e.grooveName),
          }),
        ),
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.void));
}
