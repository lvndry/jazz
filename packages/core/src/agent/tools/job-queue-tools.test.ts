import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { JOB_OUTPUT_TAIL_CHARS } from "@/core/constants/job-queue";
import {
  JobQueueServiceTag,
  type JobBatchRecord,
  type JobQueueService,
  type JobRecord,
} from "@/core/interfaces/job-queue-service";
import { createJobQueueTools } from "./job-queue-tools";

function job(overrides: Partial<JobRecord> & Pick<JobRecord, "id" | "command">): JobRecord {
  return {
    status: "succeeded",
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

const BATCH: JobBatchRecord = {
  id: "b1",
  agentId: "a1",
  conversationId: "c1",
  workingDir: "/repo",
  concurrencyCap: 1,
  backoff: { initialMs: 1000, maxMs: 1000 },
  reason: "watch the worktree",
  createdAt: 0,
  completedAt: 1,
  jobs: [
    job({
      id: "j1",
      command: "git status --short",
      result: { stdout: " M packages/protocol/src/index.ts", stderr: "", exitCode: 0 },
    }),
    job({
      id: "j2",
      command: "bun test",
      status: "failed",
      result: { stdout: "", stderr: "1 test failed", exitCode: 1 },
    }),
    job({
      id: "j3",
      command: "build",
      result: {
        stdout: `${"x".repeat(JOB_OUTPUT_TAIL_CHARS * 2)}THE-VERDICT`,
        stderr: "",
        exitCode: 0,
      },
    }),
  ],
};

const serviceLayer = Layer.succeed(JobQueueServiceTag, {
  enqueueBatch: () => Effect.die("unused"),
  getBatch: () => Effect.succeed(BATCH),
  listActiveBatches: () => Effect.succeed([BATCH]),
  cancelBatch: () => Effect.die("unused"),
} as unknown as JobQueueService);

function listJobs() {
  const { listJobs: tool } = createJobQueueTools();
  return Effect.runPromise(
    tool
      .execute({}, { agentId: "a1" } as Parameters<typeof tool.execute>[1])
      .pipe(Effect.provide(Layer.merge(serviceLayer, NodeFileSystem.layer))) as Effect.Effect<
      { success: boolean; result: unknown },
      never
    >,
  );
}

describe("list_jobs", () => {
  /**
   * The regression: the tool returned status and exit code only, so an agent asking what its
   * background jobs found got back proof they ran and nothing about what they saw.
   */
  it("returns what each job printed", async () => {
    const result = await listJobs();
    const [batch] = (
      result.result as { batches: readonly { jobs: readonly Record<string, unknown>[] }[] }
    ).batches;
    const jobs = batch?.jobs ?? [];

    expect(jobs[0]?.["stdout"]).toContain("M packages/protocol/src/index.ts");
    expect(jobs[1]?.["stderr"]).toBe("1 test failed");
  });

  it("leaves an empty stream null rather than reporting an empty string", async () => {
    const result = await listJobs();
    const [batch] = (
      result.result as { batches: readonly { jobs: readonly Record<string, unknown>[] }[] }
    ).batches;

    expect(batch?.jobs[0]?.["stderr"]).toBeNull();
  });

  it("keeps the tail of a long output, and marks that it cut", async () => {
    const result = await listJobs();
    const [batch] = (
      result.result as { batches: readonly { jobs: readonly Record<string, unknown>[] }[] }
    ).batches;
    const stdout = batch?.jobs[2]?.["stdout"] as string;

    expect(stdout).toContain("THE-VERDICT");
    expect(stdout).toContain("earlier output trimmed");
    expect(stdout.length).toBeLessThan(JOB_OUTPUT_TAIL_CHARS * 2);
  });
});
