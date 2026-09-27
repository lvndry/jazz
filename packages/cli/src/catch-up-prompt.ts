/**
 * Interactive prompt shown on jazz startup offering to run any scheduled
 * workflows that were missed (e.g. the machine was asleep at the scheduled time).
 */

import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { QuietPresentationServiceLayer } from "@jazz/core/presentation/quiet-presentation-service";
import {
  claimWorkflowRuns,
  getCatchUpCandidates,
  runClaimedWorkflow,
  type CatchUpCandidate,
} from "@jazz/core/workflows/catch-up";
import { addRunRecord } from "@jazz/core/workflows/run-history";
import { scheduleId } from "@jazz/core/workflows/scheduler-service";
import { Effect } from "effect";

function formatMissedTime(scheduledAt: Date | undefined): string {
  if (!scheduledAt) return "unknown time";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const scheduledDay = new Date(
    scheduledAt.getFullYear(),
    scheduledAt.getMonth(),
    scheduledAt.getDate(),
  );

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
 *
 * This function lives in the CLI layer because it directly uses interactive terminal
 * methods (confirm, checkbox, warn, log). Core workflow logic (getCatchUpCandidates,
 * claimWorkflowRuns, runClaimedWorkflow) remains in src/core/workflows/catch-up.ts.
 */
export function promptInteractiveCatchUp() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (!terminal.isInteractive) {
      return;
    }

    const candidates = yield* getCatchUpCandidates().pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly CatchUpCandidate[])),
    );

    if (candidates.length === 0) {
      return;
    }

    const logger = yield* LoggerServiceTag;

    // Show notification about pending catch-ups
    yield* terminal.log("");
    yield* terminal.warn(
      `${candidates.length} workflow${candidates.length > 1 ? "s" : ""} need${candidates.length === 1 ? "s" : ""} to catch up:`,
    );

    for (const candidate of candidates) {
      const missedStr = formatMissedTime(candidate.decision.scheduledAt);
      yield* terminal.log(`   • ${scheduleId(candidate.entry)} (${missedStr})`);
    }

    yield* terminal.log("");

    // Ask if user wants to catch up
    const wantsCatchUp = yield* terminal.confirm("Would you like to catch them up?", false);

    if (wantsCatchUp === undefined) {
      yield* terminal.log("");
      return;
    }

    if (!wantsCatchUp) {
      const skippedAt = new Date().toISOString();
      for (const candidate of candidates) {
        yield* addRunRecord({
          workflowName: candidate.entry.workflowName,
          scheduleLabel: candidate.entry.label,
          startedAt: skippedAt,
          completedAt: skippedAt,
          status: "skipped",
          triggeredBy: "scheduled",
        }).pipe(Effect.catchAll(() => Effect.void));
      }

      yield* terminal.log("");
      return;
    }

    // Let user select which workflows to run
    const choices = candidates.map((c) => ({
      name: `${scheduleId(c.entry)} (${formatMissedTime(c.decision.scheduledAt)})`,
      value: scheduleId(c.entry),
    }));

    // Pre-select all by default
    const defaultSelected = candidates.map((c) => scheduleId(c.entry));

    yield* terminal.log("");
    const selected = yield* terminal.checkbox<string>(
      "Select workflows to catch up (Space to toggle, Enter to confirm):",
      { choices, default: defaultSelected },
    );

    if (selected === undefined || selected.length === 0) {
      yield* terminal.info("No workflows selected.");
      yield* terminal.log("");
      return;
    }

    const entriesToRun = candidates
      .filter((c) => selected.includes(scheduleId(c.entry)))
      .map((c) => c.entry);

    yield* terminal.log("");
    yield* terminal.info(
      `Running ${entriesToRun.length} workflow${entriesToRun.length > 1 ? "s" : ""} in background...`,
    );
    yield* terminal.log("");

    // Claim the slots (their "running" records land under the history lock) BEFORE forking,
    // so even if the background fiber is interrupted when the main command finishes, the next
    // CLI start sees them and does not prompt again, and no other process runs them too.
    const claims = yield* claimWorkflowRuns(entriesToRun);

    // Quiet presentation, so "pilot is thinking" and tool output don't overwrite the main UI.
    yield* Effect.fork(
      Effect.forEach(claims, runClaimedWorkflow, { discard: true }).pipe(
        Effect.provide(QuietPresentationServiceLayer),
        Effect.tap(() =>
          logger.info("Background catch-up completed", {
            scheduleCount: claims.length,
          }),
        ),
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.void));
}
