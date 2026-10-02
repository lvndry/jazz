import type { JobBatchRecord, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { describe, expect, test } from "bun:test";
import {
  backgroundItems,
  describeBackgroundTiming,
  formatBackgroundWork,
  sameBackgroundItems,
} from "./background-work";

function job(poll: boolean): JobRecord {
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
