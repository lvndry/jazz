import { Effect } from "effect";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { QuietPresentationServiceLayer } from "@/core/presentation/quiet-presentation-service";
import {
  getCatchUpCandidates,
  runCatchUpForWorkflows,
  type CatchUpCandidate,
} from "@/core/workflows/catch-up";
import { addRunRecord } from "@/core/workflows/run-history";

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
 * runCatchUpForWorkflows) remains in src/core/workflows/catch-up.ts.
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
      const skippedAt = new Date().toISOString();
      for (const candidate of candidates) {
        yield* addRunRecord({
          workflowName: candidate.entry.workflowName,
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
    yield* terminal.info(
      `Running ${entriesToRun.length} workflow${entriesToRun.length > 1 ? "s" : ""} in background...`,
    );
    yield* terminal.log("");

    // Persist "running" records BEFORE forking so that even if the background
    // fiber is interrupted (e.g. the main command finishes first and the scope
    // closes), the next CLI invocation sees these records and won't re-prompt.
    const startedAt = new Date().toISOString();
    for (const entry of entriesToRun) {
      yield* addRunRecord({
        workflowName: entry.workflowName,
        startedAt,
        status: "running",
        triggeredBy: "scheduled",
      }).pipe(Effect.catchAll(() => Effect.void));
    }

    // Fork the catch-up execution so it runs in the background.
    // Use quiet presentation so "pilot is thinking" and tool output don't overwrite the main UI.
    // Pass recordsPreCreated so the fork skips the decideCatchUp re-check (which would
    // see the records we just wrote and incorrectly conclude "already ran") and skips
    // addRunRecord (already done above).
    yield* Effect.fork(
      runCatchUpForWorkflows(entriesToRun, { recordsPreCreated: true }).pipe(
        Effect.provide(QuietPresentationServiceLayer),
        Effect.tap(() =>
          logger.info("Background catch-up completed", {
            workflows: entriesToRun.map((e) => e.workflowName),
          }),
        ),
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.void));
}
