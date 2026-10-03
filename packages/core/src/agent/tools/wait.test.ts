import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
  SHELL_COMMAND_MAX_TIMEOUT_MS,
  WAIT_FOR_FIRST_CHECK_TIMEOUT_MS,
  WAIT_FOR_MIN_INTERVAL_MS,
} from "@/core/constants/agent";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import {
  JobQueueServiceTag,
  type EnqueueBatchJobInput,
  type EnqueueBatchOptions,
  type JobQueueService,
} from "@/core/interfaces/job-queue-service";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { createWaitTools } from "./wait";

const fileSystemContext: FileSystemContextService = {
  getCwd: () => Effect.succeed(process.cwd()),
  setCwd: () => Effect.void,
  resolvePath: (_key, path) =>
    Effect.succeed(path.startsWith("/") ? path : `${process.cwd()}/${path}`),
  findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
  resolvePathForMkdir: (_key, path) =>
    Effect.succeed(path.startsWith("/") ? path : `${process.cwd()}/${path}`),
  escapePath: (path) => path,
};

const logger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
};

interface EnqueueCall {
  readonly conversationId: string;
  readonly jobs: readonly EnqueueBatchJobInput[];
  readonly options: EnqueueBatchOptions;
}

interface CancelCall {
  readonly agentId: string;
  readonly batchId: string;
}

const enqueueCalls: EnqueueCall[] = [];
const cancelCalls: CancelCall[] = [];

const jobQueue: JobQueueService = {
  enqueueBatch: (_agentId, conversationId, jobs, options) => {
    enqueueCalls.push({ conversationId, jobs, options });
    return Effect.succeed({
      success: true as const,
      batch: { id: "batch-1", jobs: [] } as never,
    });
  },
  getBatch: () => Effect.succeed(null),
  listActiveBatches: () => Effect.succeed([]),
  cancelBatch: (agentId, batchId) => {
    cancelCalls.push({ agentId, batchId });
    return Effect.succeed({ success: true, message: `Cancelled wait_for batch ${batchId}.` });
  },
};

const testLayer = Layer.mergeAll(
  Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
  Layer.succeed(JobQueueServiceTag, jobQueue),
  Layer.succeed(LoggerServiceTag, logger),
  NodeFileSystem.layer,
);

const tools = createWaitTools();

function run(args: Record<string, unknown>, options: { withConversation?: boolean } = {}) {
  const context =
    options.withConversation === false
      ? { agentId: "agent-1" }
      : { agentId: "agent-1", conversationId: "conversation-1" };
  return Effect.runPromise(
    tools.execute
      .execute(args, context as ToolExecutionContext)
      .pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, Error, never>,
  );
}

function runCancel(args: Record<string, unknown>) {
  return Effect.runPromise(
    tools.cancelWaitFor
      .execute(args, { agentId: "agent-1" } as ToolExecutionContext)
      .pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, Error, never>,
  );
}

describe("wait_for", () => {
  /**
   * The call must hand the poll to the background worker and come back quickly; blocking the
   * turn for the whole wait is what this tool exists to avoid.
   */
  it("enqueues the wait as a poll job and returns without waiting it out", async () => {
    enqueueCalls.length = 0;
    const result = await run({
      command: "echo building; false",
      description: "a slow condition",
      intervalMs: 2_000,
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(true);
    expect((result.result as { batchId: string }).batchId).toBe("batch-1");
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.conversationId).toBe("conversation-1");
    expect(enqueueCalls[0]?.options.reason).toBe("a slow condition");
    expect(enqueueCalls[0]?.jobs).toEqual([
      { command: "echo building; false", poll: { intervalMs: 2_000, timeoutMs: 60_000 } },
    ]);
  });

  /**
   * A check that can never pass (a wrong jq filter, a grep for text that never appears) must
   * show what it observes on the call itself, not after the whole wait has run out.
   */
  it("returns the first check's exit code and output with the batch", async () => {
    const result = await run({ command: "echo completed...; exit 1", description: "a run" });

    expect(result.result).toMatchObject({
      status: "watching",
      firstCheck: { exitCode: 1, output: "completed..." },
    });
    expect((result.result as { note?: string }).note).toBeUndefined();
  });

  it("flags a first check that printed nothing", async () => {
    const result = await run({ command: "false", description: "a silent check" });

    expect((result.result as { note?: string }).note).toContain("printed nothing");
  });

  it("schedules nothing when the condition already holds", async () => {
    enqueueCalls.length = 0;
    const result = await run({ command: "echo ready", description: "already done" });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ status: "holds", output: "ready" });
    expect(enqueueCalls).toHaveLength(0);
  });

  it(
    "still enqueues a check that outlasts the first-check budget",
    async () => {
      enqueueCalls.length = 0;
      const started = Date.now();
      const result = await run({ command: "sleep 600; true", description: "a slow check" });

      expect(Date.now() - started).toBeLessThan(WAIT_FOR_FIRST_CHECK_TIMEOUT_MS + 3_000);
      expect(result.result).toMatchObject({
        status: "watching",
        firstCheck: { output: expect.stringContaining("timed out") },
      });
      expect(enqueueCalls).toHaveLength(1);
    },
    WAIT_FOR_FIRST_CHECK_TIMEOUT_MS + 5_000,
  );

  it("defaults the interval and the timeout when they are not given", async () => {
    enqueueCalls.length = 0;
    await run({ command: "false", description: "defaults" });

    expect(enqueueCalls[0]?.jobs[0]?.poll?.timeoutMs).toBe(SHELL_COMMAND_MAX_TIMEOUT_MS);
    expect(enqueueCalls[0]?.jobs[0]?.poll?.intervalMs).toBeGreaterThanOrEqual(
      WAIT_FOR_MIN_INTERVAL_MS,
    );
  });

  it("refuses when there is no conversation to wake", async () => {
    enqueueCalls.length = 0;
    const result = await run(
      { command: "true", description: "nobody to wake" },
      { withConversation: false },
    );

    expect(result.success).toBe(false);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("refuses a budget beyond the ceiling instead of silently capping it", async () => {
    const result = await run({
      command: "true",
      description: "too long",
      timeoutMs: SHELL_COMMAND_MAX_TIMEOUT_MS + 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`at most ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}`);
  });

  it("refuses an interval below the floor", async () => {
    const result = await run({
      command: "true",
      description: "too tight",
      intervalMs: WAIT_FOR_MIN_INTERVAL_MS - 1,
    });

    expect(result.success).toBe(false);
  });

  it("blocks a denylisted command before enqueueing it", async () => {
    enqueueCalls.length = 0;
    const result = await run({ command: "sudo rm -rf /", description: "blocked" });

    expect(result.success).toBe(false);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("is not a long-running tool, since the call returns at once", () => {
    expect(tools.execute.longRunning).toBeUndefined();
  });
});

describe("cancel_wait_for", () => {
  it("has the expected shape", () => {
    expect(tools.cancelWaitFor.name).toBe("cancel_wait_for");
    expect(tools.cancelWaitFor.riskLevel).toBe("low-risk");
    expect(tools.cancelWaitFor.hidden).toBe(false);
  });

  it("dispatches cancel to the service and reports success", async () => {
    cancelCalls.length = 0;
    const result = await runCancel({ batchId: "batch-1" });

    expect(result.success).toBe(true);
    expect(cancelCalls).toEqual([{ agentId: "agent-1", batchId: "batch-1" }]);
    expect(result.result).toEqual({ message: "Cancelled wait_for batch batch-1." });
  });

  it("surfaces a failed cancellation as a failed tool result", async () => {
    const failingLayer = Layer.mergeAll(
      Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
      Layer.succeed(JobQueueServiceTag, {
        ...jobQueue,
        cancelBatch: () => Effect.succeed({ success: false, message: "No wait found." }),
      }),
      Layer.succeed(LoggerServiceTag, logger),
      NodeFileSystem.layer,
    );

    const result = await Effect.runPromise(
      tools.cancelWaitFor
        .execute({ batchId: "missing" }, { agentId: "agent-1" } as ToolExecutionContext)
        .pipe(Effect.provide(failingLayer)) as Effect.Effect<ToolExecutionResult, Error, never>,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("No wait found.");
  });
});
