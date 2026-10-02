import type { JobBatchRecord, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { describe, expect, test } from "bun:test";
import {
  backgroundItems,
  describeBackgroundCheck,
  describeBackgroundTiming,
  formatBackgroundWork,
  sameBackgroundItems,
} from "./background-work";

function job(poll: boolean, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    command: "true",
    ...(poll ? { poll: { intervalMs: 1000, timeoutMs: 60000 } } : {}),
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    nextAttemptAt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    result: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function batch(overrides: Partial<JobBatchRecord> & { poll?: boolean }): JobBatchRecord {
  const { poll = true, ...rest } = overrides;
  return {
    id: "batch-1",
    agentId: "agent-1",
    conversationId: "conversation-1",
    workingDir: "/tmp",
    concurrencyCap: 1,
    backoff: { initialMs: 1000, maxMs: 1000 },
    reason: "",
    createdAt: 0,
    completedAt: null,
    deliveredAt: null,
    jobs: [job(poll)],
    ...rest,
  };
}

describe("backgroundItems", () => {
  test("lists this conversation's unfinished batches, oldest first, with a watch's timing", () => {
    const items = backgroundItems(
      [
        batch({ id: "late", createdAt: 9000 }),
        batch({ id: "early", createdAt: 1000, reason: "CI run", poll: false }),
      ],
      "conversation-1",
    );
    expect(items.map((item) => [item.batchId, item.kind, item.description])).toEqual([
      ["early", "job", "CI run"],
      ["late", "watch", "true"],
    ]);
    expect(items[1]?.intervalMs).toBe(1000);
    expect(items[1]?.expiresAt).toBe(69000);
  });

  test("ignores finished batches and other conversations", () => {
    const items = backgroundItems(
      [batch({ completedAt: 5 }), batch({ conversationId: "conversation-2" })],
      "conversation-1",
    );
    expect(items).toEqual([]);
  });
});

describe("batch progress", () => {
  const jobs = [
    job(false, { id: "a", command: "build", status: "succeeded" }),
    job(false, {
      id: "b",
      command: "lint",
      status: "failed",
      result: { stdout: "", stderr: "warn\nconnection refused\n", exitCode: 2 },
    }),
    job(false, { id: "c", command: "test", status: "running" }),
    job(false, { id: "d", command: "deploy", status: "pending" }),
  ];

  test("counts finished and failed jobs and names the one running", () => {
    const [item] = backgroundItems([batch({ poll: false, jobs })], "conversation-1");
    expect(item?.progress).toBe("1 of 4 done · 1 failed");
    expect(item?.current).toBe("test");
    expect(item?.failure).toBe("exit 2: connection refused");
    expect(item && describeBackgroundCheck(item)).toBe(
      "1 of 4 done · 1 failed · test · exit 2: connection refused",
    );
  });

  test("a single untouched job shows its command", () => {
    const [item] = backgroundItems([batch({ poll: false })], "conversation-1");
    expect(item?.progress).toBe("");
    expect(item && describeBackgroundCheck(item)).toBe("true");
  });

  test("a change in progress is a change in the list", () => {
    const before = backgroundItems([batch({ poll: false, jobs })], "conversation-1");
    const advanced = jobs.map((entry) =>
      entry.id === "c" ? { ...entry, status: "succeeded" as const } : entry,
    );
    const after = backgroundItems([batch({ poll: false, jobs: advanced })], "conversation-1");
    expect(sameBackgroundItems(before, after)).toBe(false);
  });
});

describe("watch progress", () => {
  test("shows the newest saved check, and the command until one has run", () => {
    const fresh = backgroundItems([batch({})], "conversation-1")[0];
    expect(fresh && describeBackgroundCheck(fresh)).toBe("every 1s: true");

    const checked = backgroundItems(
      [
        batch({
          jobs: [
            job(true, {
              progress: { checks: 12, lastExitCode: 1, lastCheckedAt: 5, lastOutput: "building" },
            }),
          ],
        }),
      ],
      "conversation-1",
    )[0];
    expect(checked?.progress).toBe("check 12 · exit 1 · building");
    expect(checked && describeBackgroundCheck(checked)).toBe("check 12 · exit 1 · building");
  });
});

describe("formatBackgroundWork", () => {
  const watch = backgroundItems([batch({ id: "a" })], "conversation-1");
  const job = backgroundItems([batch({ id: "b", poll: false })], "conversation-1");

  test("is silent when nothing runs", () => {
    expect(formatBackgroundWork([])).toBeUndefined();
  });

  test("names waits and jobs, pluralizing jobs", () => {
    expect(formatBackgroundWork(watch)).toBe("watching 1");
    expect(formatBackgroundWork(job)).toBe("1 job running");
    expect(formatBackgroundWork([...watch, ...watch, ...job, ...job, ...job])).toBe(
      "watching 2 · 3 jobs running",
    );
  });
});

describe("describeBackgroundTiming", () => {
  test("counts a watch down to its deadline and a job up from its start", () => {
    const [watch, job] = backgroundItems(
      [batch({ id: "a", createdAt: 0 }), batch({ id: "b", createdAt: 1, poll: false })],
      "conversation-1",
    );
    expect(watch && describeBackgroundTiming(watch, 20000)).toBe("gives up in 40s");
    expect(job && describeBackgroundTiming(job, 31001)).toBe("running 31s");
  });
});

describe("sameBackgroundItems", () => {
  test("compares batch ids in order", () => {
    const first = backgroundItems([batch({ id: "a" })], "conversation-1");
    const second = backgroundItems([batch({ id: "b" })], "conversation-1");
    expect(sameBackgroundItems(first, first)).toBe(true);
    expect(sameBackgroundItems(first, second)).toBe(false);
  });
});
