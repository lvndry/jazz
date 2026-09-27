import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  ARCHIVED_BATCH_RETENTION_MS,
  COMPLETED_BATCH_ARCHIVE_GRACE_MS,
  JOB_LEASE_TIMEOUT_MS,
  MAX_ACTIVE_BATCHES_PER_AGENT,
  MAX_JOBS_PER_BATCH,
} from "@jazz/core/constants/job-queue";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  archiveBatch,
  archiveCompletedBatches,
  claimBatchFanIn,
  claimDueJobs,
  completeJob,
  listAgentIdsWithActiveBatches,
  JobQueueServiceImpl,
  listUndeliveredBatches,
  nextClaimableAt,
  reclaimExpiredLeases,
  renewJobLease,
  settleBatchFanIn,
} from "./job-queue-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-job-queue-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeService(): JobQueueServiceImpl {
  return new JobQueueServiceImpl({ baseJobBatchDirectory: tmpDir });
}

function jobInputs(count: number) {
  return Array.from({ length: count }, (_, i) => ({ command: `echo job-${i}` }));
}

describe("enqueueBatch", () => {
  test("creates a batch with one pending job per input, immediately claimable", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(3), {
        workingDir: "/tmp",
        reason: "test batch",
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(outcome.batch.jobs).toHaveLength(3);
    expect(outcome.batch.jobs.every((job) => job.status === "pending")).toBe(true);
    expect(outcome.batch.completedAt).toBeNull();
  });

  test("rejects an empty batch", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", [], { workingDir: "/tmp", reason: "empty" }),
    );
    expect(outcome.success).toBe(false);
  });

  test("rejects a batch exceeding the per-batch job cap", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(MAX_JOBS_PER_BATCH + 1), {
        workingDir: "/tmp",
        reason: "too many",
      }),
    );
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.message).toContain("exceeding the maximum");
  });

  test("rejects once the active-batch-per-agent cap is reached", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_ACTIVE_BATCHES_PER_AGENT; i++) {
      const outcome = await runEffect(
        service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
          workingDir: "/tmp",
          reason: `batch ${i}`,
        }),
      );
      expect(outcome.success).toBe(true);
    }
    const rejected = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "one too many",
      }),
    );
    expect(rejected.success).toBe(false);
  });

  test("keeps different agents' batches separate", async () => {
    const service = makeService();
    await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), { workingDir: "/tmp", reason: "a" }),
    );
    await runEffect(
      service.enqueueBatch("agent-2", "conv-2", jobInputs(1), { workingDir: "/tmp", reason: "b" }),
    );
    const listOne = await runEffect(service.listActiveBatches("agent-1"));
    const listTwo = await runEffect(service.listActiveBatches("agent-2"));
    expect(listOne).toHaveLength(1);
    expect(listTwo).toHaveLength(1);
    expect(listOne[0]?.reason).toBe("a");
    expect(listTwo[0]?.reason).toBe("b");
  });
});

describe("claimDueJobs", () => {
  test("never claims the same job twice across concurrent claim attempts", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(6), {
        workingDir: "/tmp",
        reason: "claim race",
        concurrencyCap: 10,
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;

    const now = Date.now();
    const [first, second] = await Promise.all([
      runEffect(claimDueJobs(tmpDir, "agent-1", now, 4, "worker-a")),
      runEffect(claimDueJobs(tmpDir, "agent-1", now, 4, "worker-b")),
    ]);

    const claimedIds = [...first, ...second].map((job) => job.jobId);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBe(6);
  });

  test("respects the batch's concurrencyCap even when more jobs are due", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(5), {
        workingDir: "/tmp",
        reason: "capped",
        concurrencyCap: 2,
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;

    const claimed = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 10, "worker-a"));
    expect(claimed).toHaveLength(2);

    const claimedAgain = await runEffect(
      claimDueJobs(tmpDir, "agent-1", Date.now(), 10, "worker-b"),
    );
    expect(claimedAgain).toHaveLength(0);
  });
});

describe("completeJob", () => {
  test("retries a failed job with backoff instead of failing it outright, when attempts remain", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "retry",
        maxAttempts: 3,
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    const batchId = outcome.batch.id;

    const [claimed] = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    expect(claimed).toBeDefined();
    if (!claimed) return;

    const result = await runEffect(
      completeJob(tmpDir, "agent-1", batchId, claimed.jobId, {
        success: false,
        result: { stdout: "", stderr: "boom", exitCode: 1 },
        error: "exit code 1",
      }),
    );
    expect(result.batchNowComplete).toBe(false);
    const job = result.batch?.jobs.find((j) => j.id === claimed.jobId);
    expect(job?.status).toBe("pending");
    expect(job?.attempt).toBe(1);
    expect(job?.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  test("marks fan-in complete once every job in the batch is terminal", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(2), {
        workingDir: "/tmp",
        reason: "fan-in",
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    const batchId = outcome.batch.id;

    const claimed = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 2, "worker-a"));
    expect(claimed).toHaveLength(2);

    const firstResult = await runEffect(
      completeJob(tmpDir, "agent-1", batchId, claimed[0]!.jobId, {
        success: true,
        result: { stdout: "ok", stderr: "", exitCode: 0 },
        error: null,
      }),
    );
    expect(firstResult.batchNowComplete).toBe(false);

    const secondResult = await runEffect(
      completeJob(tmpDir, "agent-1", batchId, claimed[1]!.jobId, {
        success: true,
        result: { stdout: "ok", stderr: "", exitCode: 0 },
        error: null,
      }),
    );
    expect(secondResult.batchNowComplete).toBe(true);
    expect(secondResult.batch?.completedAt).not.toBeNull();
  });

  test("a fresh service instance against the same directory sees jobs already scheduled for retry", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "restart",
        maxAttempts: 2,
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    const batchId = outcome.batch.id;

    const [claimed] = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    if (!claimed) return;
    await runEffect(
      completeJob(tmpDir, "agent-1", batchId, claimed.jobId, {
        success: false,
        result: null,
        error: "transient failure",
      }),
    );

    // Simulate a daemon restart: a brand new service instance, same on-disk directory.
    const restarted = makeService();
    const batch = await runEffect(restarted.getBatch("agent-1", batchId));
    expect(batch?.jobs[0]?.status).toBe("pending");
    expect(batch?.jobs[0]?.attempt).toBe(1);
  });
});

describe("reclaimExpiredLeases", () => {
  test("frees a job whose lease expired without completing, and fails it once attempts are exhausted", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "crash",
        maxAttempts: 1,
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;

    const claimed = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    expect(claimed).toHaveLength(1);

    const batchPath = path.join(tmpDir, "agent-1", `${outcome.batch.id}.json`);
    const stored = JSON.parse(fs.readFileSync(batchPath, "utf8"));
    const child = Bun.spawn(["true"]);
    await child.exited;
    stored.jobs[0].leaseHolder = { pid: child.pid, host: os.hostname() };
    fs.writeFileSync(batchPath, JSON.stringify(stored));

    const reclaimed = await runEffect(reclaimExpiredLeases(tmpDir, Date.now()));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.batch.jobs[0]?.status).toBe("failed");
    expect(reclaimed[0]?.batch.jobs[0]?.lastError).toContain("worker stopped");
  });

  /** The regression: after a laptop slept past the lease, a job still running was run again. */
  test("never reclaims a job whose worker on this machine is alive, however late the clock says", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), { workingDir: "/tmp", reason: "r" }),
    );
    if (!outcome.success) return;
    await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    const batchPath = path.join(tmpDir, "agent-1", `${outcome.batch.id}.json`);
    const stored = JSON.parse(fs.readFileSync(batchPath, "utf8"));
    stored.jobs[0].leaseHolder = { pid: process.ppid, host: os.hostname() };
    fs.writeFileSync(batchPath, JSON.stringify(stored));

    const reclaimed = await runEffect(
      reclaimExpiredLeases(tmpDir, Date.now() + 24 * 60 * 60 * 1000),
    );
    expect(reclaimed).toEqual([]);
  });

  test("a heartbeat renews the lease of the job its worker still holds", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), { workingDir: "/tmp", reason: "r" }),
    );
    if (!outcome.success) return;
    const [claimed] = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    if (claimed === undefined) throw new Error("nothing claimed");
    const later = Date.now() + 60_000;
    expect(
      await runEffect(
        renewJobLease(tmpDir, "agent-1", claimed.batchId, claimed.jobId, "worker-a", later),
      ),
    ).toBe(true);
    expect(
      await runEffect(
        renewJobLease(tmpDir, "agent-1", claimed.batchId, claimed.jobId, "worker-b", later),
      ),
    ).toBe(false);
    const batch = await runEffect(service.getBatch("agent-1", claimed.batchId));
    expect(batch?.jobs[0]?.leaseExpiresAt).toBe(later + JOB_LEASE_TIMEOUT_MS);
  });
});

describe("fan-in delivery", () => {
  async function completedBatch(): Promise<string> {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), { workingDir: "/tmp", reason: "r" }),
    );
    if (!outcome.success) throw new Error("enqueue failed");
    const [claimed] = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    if (claimed === undefined) throw new Error("nothing claimed");
    const result = await runEffect(
      completeJob(tmpDir, "agent-1", claimed.batchId, claimed.jobId, {
        success: true,
        result: { stdout: "ok", stderr: "", exitCode: 0 },
        error: null,
      }),
    );
    expect(result.batchNowComplete).toBe(true);
    expect(result.batch?.deliveredAt).toBeNull();
    return claimed.batchId;
  }

  /** The regression: `completedAt` was the only mark, so a failed resume turn was never retried. */
  test("a completed batch stays owed until its fan-in is delivered", async () => {
    const batchId = await completedBatch();
    expect(await runEffect(listUndeliveredBatches(tmpDir))).toEqual([
      { agentId: "agent-1", batchId },
    ]);

    const claimed = await runEffect(claimBatchFanIn(tmpDir, "agent-1", batchId));
    expect(claimed?.fanIn?.status).toBe("firing");
    expect(await runEffect(claimBatchFanIn(tmpDir, "agent-1", batchId))).toBeNull();

    await runEffect(
      settleBatchFanIn(tmpDir, "agent-1", batchId, {
        delivered: false,
        error: "provider outage",
        retryable: true,
      }),
    );
    const failed = await runEffect(makeService().getBatch("agent-1", batchId));
    expect(failed?.deliveredAt).toBeNull();
    expect(failed?.fanIn).toMatchObject({ status: "failed", lastError: "provider outage" });

    const retryAt = failed?.fanIn?.status === "failed" ? (failed.fanIn.nextAttemptAt ?? 0) : 0;
    expect(
      await runEffect(claimBatchFanIn(tmpDir, "agent-1", batchId, retryAt + 1)),
    ).not.toBeNull();
    await runEffect(settleBatchFanIn(tmpDir, "agent-1", batchId, { delivered: true }));
    const delivered = await runEffect(makeService().getBatch("agent-1", batchId));
    expect(delivered?.deliveredAt).not.toBeNull();
    expect(delivered?.fanIn).toBeUndefined();
    expect(await runEffect(listUndeliveredBatches(tmpDir))).toEqual([]);
  });

  test("a batch completed before fan-in delivery existed reads as delivered", async () => {
    fs.mkdirSync(path.join(tmpDir, "agent-1"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "agent-1", "old.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "old",
        agentId: "agent-1",
        conversationId: "conv-1",
        workingDir: "/tmp",
        concurrencyCap: 1,
        backoff: { initialMs: 1, maxMs: 1 },
        reason: "r",
        createdAt: 1,
        completedAt: 2,
        jobs: [],
      }),
    );
    expect(await runEffect(listUndeliveredBatches(tmpDir))).toEqual([]);
  });
});

describe("cancelBatch", () => {
  test("cancels pending jobs and completes the batch when nothing is left running", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(3), {
        workingDir: "/tmp",
        reason: "cancel",
      }),
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;

    const cancelOutcome = await runEffect(service.cancelBatch("agent-1", outcome.batch.id));
    expect(cancelOutcome.success).toBe(true);

    const batch = await runEffect(service.getBatch("agent-1", outcome.batch.id));
    expect(batch?.jobs.every((job) => job.status === "cancelled")).toBe(true);
    expect(batch?.completedAt).not.toBeNull();
  });
});

/**
 * A worker draining an agent's batches has to tell "nothing left to do" apart from "nothing due
 * yet". A job waiting out its retry backoff is the second, and exiting on it abandons the batch
 * half-finished with nobody scheduled to come back for it.
 */
describe("nextClaimableAt", () => {
  test("returns null for an agent with no batches at all", async () => {
    expect(await runEffect(nextClaimableAt(tmpDir, "nobody"))).toBeNull();
  });

  test("returns the soonest pending attempt time", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("a1", "c1", jobInputs(2), { workingDir: "/tmp", reason: "r" }),
    );
    expect(outcome.success).toBe(true);

    const soonest = await runEffect(nextClaimableAt(tmpDir, "a1"));
    expect(soonest).not.toBeNull();
    expect(soonest).toBeLessThanOrEqual(Date.now());
  });

  test("returns null once every job has reached a terminal state", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("a1", "c1", jobInputs(1), { workingDir: "/tmp", reason: "r" }),
    );
    if (!outcome.success) throw new Error(outcome.message);

    const claimed = await runEffect(claimDueJobs(tmpDir, "a1", Date.now(), 4, "owner"));
    expect(claimed.length).toBe(1);
    for (const job of claimed) {
      await runEffect(
        completeJob(tmpDir, "a1", job.batchId, job.jobId, {
          success: true,
          result: { stdout: "ok", stderr: "", exitCode: 0 },
          error: null,
        }),
      );
    }

    expect(await runEffect(nextClaimableAt(tmpDir, "a1"))).toBeNull();
  });

  test("still reports a job that is pending but not yet due", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("a1", "c1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "r",
        maxAttempts: 3,
      }),
    );
    if (!outcome.success) throw new Error(outcome.message);

    const claimed = await runEffect(claimDueJobs(tmpDir, "a1", Date.now(), 4, "owner"));
    const first = claimed[0];
    if (first === undefined) throw new Error("expected a claimed job");
    await runEffect(
      completeJob(tmpDir, "a1", first.batchId, first.jobId, {
        success: false,
        result: null,
        error: "flaky",
      }),
    );

    // Retried with backoff, so it is pending with a future attempt time — unfinished work, not
    // an empty queue.
    const soonest = await runEffect(nextClaimableAt(tmpDir, "a1"));
    expect(soonest).not.toBeNull();
    expect(soonest).toBeGreaterThan(Date.now());
  });
});

describe("archiving delivered batches", () => {
  async function completedBatch(service: JobQueueServiceImpl, delivered = true) {
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "archive me",
      }),
    );
    if (!outcome.success) {
      throw new Error(outcome.message);
    }
    const [claimed] = await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker-a"));
    if (claimed === undefined) {
      throw new Error("nothing claimed");
    }
    const completed = await runEffect(
      completeJob(tmpDir, "agent-1", outcome.batch.id, claimed.jobId, {
        success: true,
        result: { stdout: "done", stderr: "", exitCode: 0 },
        error: null,
      }),
    );
    if (completed.batch === null) {
      throw new Error("batch vanished");
    }
    if (!delivered) return completed.batch;
    await runEffect(claimBatchFanIn(tmpDir, "agent-1", completed.batch.id));
    await runEffect(settleBatchFanIn(tmpDir, "agent-1", completed.batch.id, { delivered: true }));
    return (await runEffect(service.getBatch("agent-1", completed.batch.id)))!;
  }

  function activeBatchFiles(): string[] {
    return fs.readdirSync(path.join(tmpDir, "agent-1")).filter((name) => name.endsWith(".json"));
  }

  test("moves a completed batch out of the directory the tick scans, and keeps it readable", async () => {
    const service = makeService();
    const batch = await completedBatch(service);

    expect(await runEffect(archiveBatch(tmpDir, "agent-1", batch.id))).toBe(true);

    expect(activeBatchFiles()).toEqual([]);
    const readBack = await runEffect(service.getBatch("agent-1", batch.id));
    expect(readBack?.jobs[0]?.result?.stdout).toBe("done");
    expect(await runEffect(listAgentIdsWithActiveBatches(tmpDir))).toEqual(["agent-1"]);
  });

  test("neither direct archival nor the sweep removes undelivered or failed fan-in", async () => {
    const batch = await completedBatch(makeService(), false);
    const later = Date.now() + COMPLETED_BATCH_ARCHIVE_GRACE_MS + 1_000;
    expect(await runEffect(archiveBatch(tmpDir, "agent-1", batch.id, later))).toBe(false);
    expect(await runEffect(archiveCompletedBatches(tmpDir, later))).toBe(0);
    await runEffect(claimBatchFanIn(tmpDir, "agent-1", batch.id));
    await runEffect(
      settleBatchFanIn(tmpDir, "agent-1", batch.id, {
        delivered: false,
        error: "provider down",
        retryable: true,
      }),
    );
    expect(await runEffect(archiveBatch(tmpDir, "agent-1", batch.id, later))).toBe(false);
    expect(await runEffect(archiveCompletedBatches(tmpDir, later))).toBe(0);
    expect(activeBatchFiles()).toEqual([`${batch.id}.json`]);
  });

  test("leaves a batch that is still running where it is", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), {
        workingDir: "/tmp",
        reason: "still going",
      }),
    );
    if (!outcome.success) {
      throw new Error(outcome.message);
    }
    expect(await runEffect(archiveBatch(tmpDir, "agent-1", outcome.batch.id))).toBe(false);
    expect(activeBatchFiles()).toHaveLength(1);
  });

  test("deletes archived batches past their retention", async () => {
    const service = makeService();
    const first = await completedBatch(service);
    const archivedAt = Date.now() - ARCHIVED_BATCH_RETENTION_MS - 1_000;
    await runEffect(archiveBatch(tmpDir, "agent-1", first.id, archivedAt));
    const second = await completedBatch(service);
    await runEffect(archiveBatch(tmpDir, "agent-1", second.id));

    expect(await runEffect(service.getBatch("agent-1", first.id))).toBeNull();
    expect(await runEffect(service.getBatch("agent-1", second.id))).not.toBeNull();
  });

  test("the sweep archives completed batches whose resume never archived them", async () => {
    const service = makeService();
    const batch = await completedBatch(service);
    const completedAt = batch.deliveredAt ?? Date.now();

    expect(await runEffect(archiveCompletedBatches(tmpDir, completedAt + 1_000))).toBe(0);
    expect(activeBatchFiles()).toHaveLength(1);

    const later = completedAt + COMPLETED_BATCH_ARCHIVE_GRACE_MS + 1_000;
    expect(await runEffect(archiveCompletedBatches(tmpDir, later))).toBe(1);
    expect(activeBatchFiles()).toEqual([]);
  });
});

describe("damaged and versioned batch files", () => {
  test("a torn batch is quarantined by the worker instead of vanishing silently", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.enqueueBatch("agent-1", "conv-1", jobInputs(1), { workingDir: "/tmp", reason: "r" }),
    );
    if (!outcome.success) throw new Error("enqueue failed");
    const batchPath = path.join(tmpDir, "agent-1", `${outcome.batch.id}.json`);
    const stored = JSON.parse(fs.readFileSync(batchPath, "utf8"));
    expect(stored.schemaVersion).toBe(2);
    expect(fs.statSync(batchPath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(batchPath, "{torn");
    expect(await runEffect(service.listActiveBatches("agent-1"))).toEqual([]);
    expect(await runEffect(claimDueJobs(tmpDir, "agent-1", Date.now(), 1, "worker"))).toEqual([]);
    const aside = fs
      .readdirSync(path.join(tmpDir, "agent-1"))
      .filter((name) => name.includes(".corrupt-"));
    expect(aside).toHaveLength(1);
  });

  test("refuses a batch written by a newer Jazz", async () => {
    fs.mkdirSync(path.join(tmpDir, "agent-1"), { recursive: true });
    const batchPath = path.join(tmpDir, "agent-1", "newer.json");
    fs.writeFileSync(batchPath, JSON.stringify({ schemaVersion: 99 }));
    const result = await runEffect(makeService().getBatch("agent-1", "newer").pipe(Effect.either));
    expect(result._tag).toBe("Left");
    expect(fs.existsSync(batchPath)).toBe(true);
  });
});
