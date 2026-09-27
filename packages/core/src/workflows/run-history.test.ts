import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  addRunRecord,
  getRunHistoryFilePath,
  lastCompletedRunAt,
  loadRunHistory,
  markInterruptedRuns,
  MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE,
  recordRunsUnderLock,
  runScheduleLabel,
  trimPerSchedule,
  updateRunRecord,
  type WorkflowRunRecord,
} from "./run-history";

const suiteJazzHome = process.env["JAZZ_HOME"];

beforeEach(() => {
  process.env["JAZZ_HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-run-history-"));
});

afterEach(() => {
  process.env["JAZZ_HOME"] = suiteJazzHome;
});

function run<A>(effect: Effect.Effect<A, Error>): Promise<A> {
  return Effect.runPromise(effect);
}

function completed(workflowName: string, label: string, index: number): WorkflowRunRecord {
  const startedAt = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
  return {
    id: `${workflowName}-${label}-${index}`,
    workflowName,
    scheduleLabel: label,
    startedAt,
    completedAt: startedAt,
    status: "completed",
    triggeredBy: "scheduled",
  };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("per-schedule last run", () => {
  const records: WorkflowRunRecord[] = [
    {
      id: "1",
      workflowName: "recap",
      scheduleLabel: "monthly",
      startedAt: "2026-08-01T09:00:00.000Z",
      completedAt: "2026-08-01T09:05:00.000Z",
      status: "completed",
      triggeredBy: "scheduled",
    },
    {
      id: "2",
      workflowName: "recap",
      scheduleLabel: "default",
      startedAt: "2026-08-28T17:00:00.000Z",
      completedAt: "2026-08-28T17:04:00.000Z",
      status: "completed",
      triggeredBy: "scheduled",
    },
    {
      id: "3",
      workflowName: "recap",
      scheduleLabel: "monthly",
      startedAt: "2026-09-01T09:00:00.000Z",
      status: "failed",
      triggeredBy: "scheduled",
    },
  ];

  it("ignores other labels and failed runs", () => {
    expect(lastCompletedRunAt(records, "recap", "monthly")).toBe("2026-08-01T09:05:00.000Z");
    expect(lastCompletedRunAt(records, "recap", "default")).toBe("2026-08-28T17:04:00.000Z");
    expect(lastCompletedRunAt(records, "recap", "manual")).toBeUndefined();
  });

  it("reads pre-label records as default when scheduled and manual otherwise", () => {
    expect(runScheduleLabel({ triggeredBy: "scheduled" })).toBe("default");
    expect(runScheduleLabel({ triggeredBy: "manual" })).toBe("manual");
  });
});

describe("retention", () => {
  /**
   * The regression (repro `evict.ts`): one global 100-record cap let a workflow that runs every
   * few minutes evict a daily workflow's record, which then looked missed and ran again.
   */
  it("keeps each schedule's own runs however often another schedule runs", () => {
    const daily = completed("daily-brief", "default", 0);
    const frequent = Array.from({ length: 200 }, (_, index) =>
      completed("inbox-check", "default", index + 1),
    );
    const kept = trimPerSchedule([daily, ...frequent]);
    expect(kept).toContainEqual(daily);
    expect(kept.filter((record) => record.workflowName === "inbox-check")).toHaveLength(
      MAX_RUN_HISTORY_RECORDS_PER_SCHEDULE,
    );
    expect(kept.at(-1)).toEqual(frequent.at(-1) as WorkflowRunRecord);
  });
});

describe("run records", () => {
  it("updates the run by its id, not the newest running record of the workflow", async () => {
    const first = await run(
      addRunRecord({
        workflowName: "recap",
        scheduleLabel: "weekly",
        startedAt: "2026-09-01T09:00:00.000Z",
        status: "running",
        triggeredBy: "scheduled",
      }),
    );
    const second = await run(
      addRunRecord({
        workflowName: "recap",
        scheduleLabel: "monthly",
        startedAt: "2026-09-01T09:00:01.000Z",
        status: "running",
        triggeredBy: "scheduled",
      }),
    );
    await run(
      updateRunRecord(first.id, { status: "completed", completedAt: "2026-09-01T10:00:00Z" }),
    );

    const history = await run(loadRunHistory());
    const byId = new Map(history.map((record) => [record.id, record]));
    expect(byId.get(first.id)?.status).toBe("completed");
    expect(byId.get(first.id)?.owner).toBeUndefined();
    expect(byId.get(second.id)?.status).toBe("running");
    expect(byId.get(second.id)?.owner?.pid).toBe(process.pid);
  });

  it("marks a running record whose process exited as interrupted", async () => {
    const pid = await deadPid();
    fs.writeFileSync(
      getRunHistoryFilePath(),
      JSON.stringify({
        schemaVersion: 2,
        runs: [
          {
            id: "crashed",
            workflowName: "recap",
            startedAt: "2026-09-01T09:00:00.000Z",
            status: "running",
            triggeredBy: "scheduled",
            owner: { pid, host: os.hostname() },
          },
        ],
      }),
    );
    expect(await run(markInterruptedRuns())).toBe(1);
    const [record] = await run(loadRunHistory());
    expect(record?.status).toBe("interrupted");
    expect(record?.completedAt).toBeDefined();
  });

  it("reads a history written before record ids, giving each record one", async () => {
    fs.writeFileSync(
      getRunHistoryFilePath(),
      JSON.stringify([
        {
          workflowName: "recap",
          startedAt: "2026-09-01T09:00:00.000Z",
          status: "completed",
          triggeredBy: "scheduled",
        },
      ]),
    );
    const [record] = await run(loadRunHistory());
    expect(record?.id).toBe("legacy-recap-2026-09-01T09:00:00.000Z");
  });

  it("lets only one of two concurrent claims record the same slot", async () => {
    const claim = () =>
      recordRunsUnderLock((history) =>
        history.some((record) => record.workflowName === "recap")
          ? []
          : [
              {
                workflowName: "recap",
                scheduleLabel: "default",
                startedAt: "2026-09-01T09:00:00.000Z",
                status: "running" as const,
                triggeredBy: "scheduled" as const,
              },
            ],
      );
    const [left, right] = await Promise.all([run(claim()), run(claim())]);
    expect(left.length + right.length).toBe(1);
    expect(await run(loadRunHistory())).toHaveLength(1);
  });
});
