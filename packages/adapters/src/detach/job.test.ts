/** Persistence and idempotency tests for the detached-run queue. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { detachEventLogPath } from "./events";
import {
  enqueueDetachedJob,
  queueDetachedAnswer,
  queueDetachedMessage,
  readDetachedJob,
  recoverInterruptedDetachedJobs,
  releaseDetachedJob,
  remainingDetachedBudgets,
  requestDetachedCancel,
  type DetachedJobStatus,
  type EnqueueDetachedJobInput,
} from "./job";

describe("detached job queue", () => {
  let home: string;
  const priorHome = process.env["JAZZ_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jazz-detach-job-"));
    process.env["JAZZ_HOME"] = home;
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = priorHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function input(): EnqueueDetachedJobInput {
    return {
      handoffId: "handoff-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      workspacePath: "/home/jazz/work",
      workspaceRoot: "/home/jazz/work/handoff-1",
      continuation: "Continue this task",
      approvalPolicy: "low-risk",
      maxCostUSD: 2,
      maxDurationMs: 3600000,
      maxIterations: 100,
    };
  }

  it("persists a private pending job and returns it on an identical retry", async () => {
    const first = await Effect.runPromise(enqueueDetachedJob(input()));
    const second = await Effect.runPromise(enqueueDetachedJob(input()));
    expect(first).toEqual(second);
    expect((await Effect.runPromise(readDetachedJob("handoff-1")))?.status).toEqual({
      kind: "pending",
    });
    expect(statSync(join(home, "detach", "jobs", "handoff-1.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects a reused handoff ID with changed authority", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    await expect(
      Effect.runPromise(
        enqueueDetachedJob({ ...input(), approvalPolicy: "low-risk", maxCostUSD: 99 }),
      ),
    ).rejects.toThrow("different job");
  });

  it("rejects invalid destination and unbounded limits before writing", async () => {
    await expect(
      Effect.runPromise(enqueueDetachedJob({ ...input(), workspaceRoot: "/tmp/other" })),
    ).rejects.toThrow("workspace");
    await expect(
      Effect.runPromise(enqueueDetachedJob({ ...input(), maxCostUSD: Number.POSITIVE_INFINITY })),
    ).rejects.toThrow("limits");
    expect(await Effect.runPromise(readDetachedJob("handoff-1"))).toBeUndefined();
  });

  it("queues an approval durably and rejects a conflicting retry", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    const file = join(home, "detach", "jobs", "handoff-1.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, status: { kind: "parked", runId: "run-1" } }));
    const queued = await Effect.runPromise(queueDetachedAnswer("handoff-1", true));
    expect(queued.status).toEqual({ kind: "answer-pending", runId: "run-1", approved: true });
    expect(await Effect.runPromise(queueDetachedAnswer("handoff-1", true))).toEqual(queued);
    await expect(Effect.runPromise(queueDetachedAnswer("handoff-1", false))).rejects.toThrow(
      "Conflicting answer",
    );
  });

  it("marks a dead worker failed without replaying the job", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    const file = join(home, "detach", "jobs", "handoff-1.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        status: { kind: "running", host: hostname(), pid: 99_999_999 },
      }),
    );
    expect(await Effect.runPromise(recoverInterruptedDetachedJobs())).toBe(1);
    expect((await Effect.runPromise(readDetachedJob("handoff-1")))?.status.kind).toBe("failed");
    expect(await Effect.runPromise(recoverInterruptedDetachedJobs())).toBe(0);
  });

  it("subtracts earlier approval segments from all resume budgets", async () => {
    const record = await Effect.runPromise(enqueueDetachedJob(input()));
    expect(
      remainingDetachedBudgets({
        ...record,
        spentCostUSD: 1.25,
        spentDurationMs: 600_000,
        spentIterations: 40,
      }),
    ).toEqual({ maxCostUSD: 0.75, maxDurationMs: 3_000_000, maxIterations: 60 });
    expect(() =>
      remainingDetachedBudgets({
        ...record,
        spentCostUSD: 2,
        spentDurationMs: 0,
        spentIterations: 0,
      }),
    ).toThrow("exhausted");
    expect(() =>
      remainingDetachedBudgets({
        ...record,
        spentCostUSD: 0,
        spentDurationMs: 3_600_000,
        spentIterations: 0,
      }),
    ).toThrow("exhausted");
    expect(() =>
      remainingDetachedBudgets({
        ...record,
        spentCostUSD: 0,
        spentDurationMs: 0,
        spentIterations: 100,
      }),
    ).toThrow("exhausted");
  });

  it("refuses corrupted persisted budget accounting", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    const file = join(home, "detach", "jobs", "handoff-1.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, spentCostUSD: null }));
    await expect(Effect.runPromise(readDetachedJob("handoff-1"))).rejects.toThrow(
      "Corrupt detach job record",
    );
  });

  function setStatus(status: DetachedJobStatus, extra: Record<string, unknown> = {}): void {
    const file = join(home, "detach", "jobs", "handoff-1.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, ...extra, status }));
  }

  function loggedEvents(): { type: string; state?: string; text?: string }[] {
    return readFileSync(detachEventLogPath("handoff-1"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; state?: string; text?: string });
  }

  it("logs the continuation as the first thing an attached terminal sees", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    expect(loggedEvents().map(({ type, state, text }) => ({ type, state, text }))).toEqual([
      { type: "user", state: undefined, text: "Continue this task" },
      { type: "status", state: "pending", text: undefined },
    ]);
  });

  it("queues a reply only once the previous turn has finished", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    await expect(Effect.runPromise(queueDetachedMessage("handoff-1", "next"))).rejects.toThrow(
      "finished turn",
    );
    setStatus({ kind: "completed", answer: "done" });
    const queued = await Effect.runPromise(queueDetachedMessage("handoff-1", "  next step  "));
    expect(queued.status).toEqual({ kind: "message-pending", text: "next step" });
    expect(
      loggedEvents().some((event) => event.type === "user" && event.text === "next step"),
    ).toBe(true);
  });

  it("refuses a reply once the handoff budget is spent", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    setStatus({ kind: "completed", answer: "done" }, { spentCostUSD: 2 });
    await expect(Effect.runPromise(queueDetachedMessage("handoff-1", "more"))).rejects.toThrow(
      "exhausted",
    );
  });

  it("fails queued work immediately and asks a running worker to stop", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    const cancelled = await Effect.runPromise(requestDetachedCancel("handoff-1"));
    expect(cancelled.status).toEqual({ kind: "failed", error: "Cancelled by operator" });

    setStatus({ kind: "running", pid: process.pid, host: hostname() });
    const running = await Effect.runPromise(requestDetachedCancel("handoff-1"));
    expect(running.status.kind).toBe("running");
    expect(existsSync(join(home, "detach", "jobs", "handoff-1.json.cancel"))).toBe(true);

    setStatus({ kind: "completed", answer: "done" });
    await expect(Effect.runPromise(requestDetachedCancel("handoff-1"))).rejects.toThrow(
      "already completed",
    );
  });

  it("releases only settled work, idempotently, and never runs it again", async () => {
    await Effect.runPromise(enqueueDetachedJob(input()));
    await expect(Effect.runPromise(releaseDetachedJob("handoff-1"))).rejects.toThrow(
      "still working",
    );
    setStatus({ kind: "completed", answer: "done" });
    const released = await Effect.runPromise(releaseDetachedJob("handoff-1"));
    expect(released.status).toEqual({ kind: "released" });
    expect(await Effect.runPromise(releaseDetachedJob("handoff-1"))).toEqual(released);
    await expect(Effect.runPromise(queueDetachedMessage("handoff-1", "more"))).rejects.toThrow(
      "released",
    );
    await expect(Effect.runPromise(queueDetachedAnswer("handoff-1", true))).rejects.toThrow(
      "not awaiting approval",
    );
  });
});
