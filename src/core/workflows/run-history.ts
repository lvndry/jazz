import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

/**
 * Record of a single workflow run.
 */
export interface WorkflowRunRecord {
  readonly workflowName: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed";
  readonly error?: string;
  readonly triggeredBy: "manual" | "scheduled";
}

/**
 * Get the path to the run history file.
 */
function getHistoryPath(): string {
  return path.join(os.homedir(), ".jazz", "run-history.json");
}

/**
 * Load the run history from disk.
 */
export function loadRunHistory(): Effect.Effect<WorkflowRunRecord[], Error> {
  return Effect.gen(function* () {
    const historyPath = getHistoryPath();

    try {
      const content = yield* Effect.tryPromise(() => fs.readFile(historyPath, "utf-8"));
      const history = JSON.parse(content) as WorkflowRunRecord[];
      return history;
    } catch {
      return [];
    }
  });
}

/**
 * Save the run history to disk.
 */
function saveRunHistory(history: WorkflowRunRecord[]): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const historyPath = getHistoryPath();
    const dir = path.dirname(historyPath);

    yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true }));
    yield* Effect.tryPromise(() => fs.writeFile(historyPath, JSON.stringify(history, null, 2)));
  });
}

/**
 * Add a new run record to the history.
 * Keeps only the last 100 records to prevent unbounded growth.
 */
export function addRunRecord(record: WorkflowRunRecord): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();

    // Add the new record
    history.push(record);

    // Keep only the last 100 records
    const trimmed = history.slice(-100);

    yield* saveRunHistory(trimmed);
  });
}

/**
 * Update the most recent run record for a workflow.
 */
export function updateLatestRunRecord(
  workflowName: string,
  update: Partial<WorkflowRunRecord>,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();

    // Find the most recent record for this workflow that is still running
    for (let i = history.length - 1; i >= 0; i--) {
      const record = history[i];
      if (record && record.workflowName === workflowName && record.status === "running") {
        history[i] = { ...record, ...update };
        yield* saveRunHistory(history);
        return;
      }
    }
  });
}

/**
 * Get run history for a specific workflow.
 */
export function getWorkflowHistory(
  workflowName: string,
): Effect.Effect<WorkflowRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.filter((r) => r.workflowName === workflowName);
  });
}

/**
 * Get the most recent runs (across all workflows).
 */
export function getRecentRuns(limit = 20): Effect.Effect<WorkflowRunRecord[], Error> {
  return Effect.gen(function* () {
    const history = yield* loadRunHistory();
    return history.slice(-limit).reverse();
  });
}
