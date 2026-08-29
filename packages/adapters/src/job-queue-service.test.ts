import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MAX_ACTIVE_BATCHES_PER_AGENT, MAX_JOBS_PER_BATCH } from "@jazz/core/constants/job-queue";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import {
  claimDueJobs,
  completeJob,
  JobQueueServiceImpl,
  reclaimExpiredLeases,
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

    // Simulate a worker that died mid-job by checking for expired leases well past the lease timeout.
    const reclaimed = await runEffect(reclaimExpiredLeases(tmpDir, Date.now() + 60 * 60 * 1000));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.batch.jobs[0]?.status).toBe("failed");
    expect(reclaimed[0]?.batch.jobs[0]?.lastError).toContain("lease expired");
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
