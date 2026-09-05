import { JOB_OUTPUT_TAIL_CHARS } from "@jazz/core/constants/job-queue";
import type { JobBatchRecord, JobRecord } from "@jazz/core/interfaces/job-queue-service";
import { describe, expect, it } from "bun:test";
import { summarizeBatch } from "./job-worker";

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

function batch(jobs: readonly JobRecord[]): JobBatchRecord {
  return {
    id: "b1",
    agentId: "a1",
    conversationId: "c1",
    workingDir: "/repo",
    concurrencyCap: 1,
    backoff: { initialMs: 1000, maxMs: 1000 },
    reason: "watch the worktree",
    createdAt: 0,
    completedAt: 1,
    jobs,
  };
}

describe("summarizeBatch", () => {
  /**
   * The regression: a batch of four `git status` snapshots reported "4/4 succeeded" and not
   * one line of what they saw, so polling a worktree could never tell the agent anything.
   */
  it("quotes what a succeeded job printed", () => {
    const summary = summarizeBatch(
      batch([
        job({
          id: "j1",
          command: "git status --short",
          result: { stdout: " M packages/protocol/src/index.ts\n", stderr: "", exitCode: 0 },
        }),
      ]),
    );

    expect(summary).toContain("M packages/protocol/src/index.ts");
    expect(summary).toContain("1/1 succeeded");
  });

  it("says so when a succeeded job printed nothing", () => {
    const summary = summarizeBatch(
      batch([job({ id: "j1", command: "true", result: { stdout: "", stderr: "", exitCode: 0 } })]),
    );

    expect(summary).toContain("succeeded with no output");
  });

  it("quotes stderr for a failed job", () => {
    const summary = summarizeBatch(
      batch([
        job({
          id: "j1",
          command: "bun test",
          status: "failed",
          attempt: 2,
          result: { stdout: "", stderr: "1 test failed", exitCode: 1 },
        }),
      ]),
    );

    expect(summary).toContain("failed after 2 attempt(s)");
    expect(summary).toContain("1 test failed");
  });

  it("falls back to stdout for a failed job that diagnosed itself there", () => {
    const summary = summarizeBatch(
      batch([
        job({
          id: "j1",
          command: "make",
          status: "failed",
          result: { stdout: "undefined reference to `main'", stderr: "", exitCode: 1 },
        }),
      ]),
    );

    expect(summary).toContain("undefined reference");
    expect(summary).not.toContain("no output captured");
  });

  it("keeps the tail of a long output, and marks that it cut", () => {
    const long = `${"x".repeat(JOB_OUTPUT_TAIL_CHARS * 2)}THE-VERDICT`;
    const summary = summarizeBatch(
      batch([
        job({ id: "j1", command: "build", result: { stdout: long, stderr: "", exitCode: 0 } }),
      ]),
    );

    expect(summary).toContain("THE-VERDICT");
    expect(summary).toContain("earlier output trimmed");
    expect(summary.length).toBeLessThan(long.length);
  });

  it("reports a cancelled job without pretending it ran", () => {
    const summary = summarizeBatch(
      batch([job({ id: "j1", command: "git fetch", status: "cancelled" })]),
    );

    expect(summary).toContain("cancelled before it ran");
    expect(summary).toContain("0/1 succeeded");
  });
});
