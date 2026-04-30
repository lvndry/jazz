import * as path from "node:path";
import { Effect } from "effect";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import { getGlobalUserDataDirectory } from "@/core/utils/runtime-detection";
import {
  getRunHistoryFilePath,
  loadRunHistory,
  type WorkflowRunRecord,
} from "@/core/workflows/run-history";
import { SchedulerServiceTag } from "@/core/workflows/scheduler-service";

/**
 * If the most recent run of any *scheduled* workflow ended in `failed`, show
 * a one-shot warning on jazz startup so the user notices silent regressions
 * (e.g. the agent the workflow was scheduled with was deleted, or the model
 * is rate-limited / out of quota). Points the user at the run-history file
 * and the per-workflow log.
 *
 * Pairs with the early `addRunRecord({ status: "running" })` move in
 * `cli/commands/workflow.ts` — without that, scheduled runs that fail at
 * agent lookup never reach the history at all and this prompt has nothing
 * to surface.
 */
export function promptFailedRunsWarning() {
  return Effect.gen(function* () {
    if (!process.stdout.isTTY) return;

    const scheduler = yield* SchedulerServiceTag;
    const scheduled = yield* scheduler
      .listScheduled()
      .pipe(Effect.catchAll(() => Effect.succeed([] as const)));

    if (scheduled.length === 0) return;

    const history = yield* loadRunHistory().pipe(
      Effect.catchAll(() => Effect.succeed([] as WorkflowRunRecord[])),
    );

    if (history.length === 0) return;

    const scheduledNames = new Set(scheduled.map((s) => s.workflowName));

    // Find the latest record (by completedAt ?? startedAt) for each scheduled
    // workflow, and keep only those whose latest is "failed".
    type Latest = { record: WorkflowRunRecord; ts: number };
    const latestByWorkflow = new Map<string, Latest>();
    for (const record of history) {
      if (!scheduledNames.has(record.workflowName)) continue;
      const ts = Date.parse(record.completedAt ?? record.startedAt);
      if (!Number.isFinite(ts)) continue;
      const existing = latestByWorkflow.get(record.workflowName);
      if (!existing || ts > existing.ts) {
        latestByWorkflow.set(record.workflowName, { record, ts });
      }
    }

    const failed: WorkflowRunRecord[] = [];
    for (const { record } of latestByWorkflow.values()) {
      if (record.status === "failed") failed.push(record);
    }

    if (failed.length === 0) return;

    const terminal = yield* TerminalServiceTag;
    const logsDir = path.join(getGlobalUserDataDirectory(), "logs");
    const historyPath = getRunHistoryFilePath();

    yield* terminal.log("");
    yield* terminal.warn(
      `${failed.length} scheduled workflow${failed.length > 1 ? "s" : ""} ${
        failed.length > 1 ? "have" : "has"
      } failed on the last run:`,
    );
    for (const record of failed) {
      const summary = record.error ? record.error.split("\n")[0] : "no error message recorded";
      yield* terminal.log(`   • ${record.workflowName} — ${summary}`);
    }
    yield* terminal.log("");
    yield* terminal.log(`   Run history: ${historyPath}`);
    yield* terminal.log(`   Logs:        ${logsDir}/<workflow>.log`);
    yield* terminal.log(
      `   Triage:      jazz workflow history <workflow>  →  inspect, then re-schedule if needed`,
    );
    yield* terminal.log("");
  }).pipe(Effect.catchAll(() => Effect.void));
}
