import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SHELL_COMMAND_MAX_TIMEOUT_MS, WAIT_FOR_MIN_INTERVAL_MS } from "@/core/constants/agent";
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

const enqueueCalls: EnqueueCall[] = [];

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
  cancelBatch: () => Effect.succeed({ success: true, message: "" }),
};

const testLayer = Layer.mergeAll(
  Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
  Layer.succeed(JobQueueServiceTag, jobQueue),
  Layer.succeed(LoggerServiceTag, logger),
  NodeFileSystem.layer,
);

const tools = createWaitTools();

function run(args: Record<string, unknown>, context: Partial<ToolExecutionContext> = {}) {
  return Effect.runPromise(
    tools.execute
      .execute(args, {
        agentId: "agent-1",
        conversationId: "conversation-1",
        ...context,
      } as ToolExecutionContext)
      .pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, Error, never>,
  );
}

describe("wait_for", () => {
  /**
   * The call must hand the poll to the background worker and come back immediately; blocking the
   * turn for the whole wait is what this tool exists to avoid.
   */
  it("enqueues the wait as a poll job and returns without running the command", async () => {
    enqueueCalls.length = 0;
    const started = Date.now();
    const result = await run({
      command: "sleep 600; true",
      description: "a slow condition",
      intervalMs: 2_000,
      timeoutMs: 60_000,
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.success).toBe(true);
    expect((result.result as { batchId: string }).batchId).toBe("batch-1");
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.conversationId).toBe("conversation-1");
    expect(enqueueCalls[0]?.options.reason).toBe("a slow condition");
    expect(enqueueCalls[0]?.jobs).toEqual([
      { command: "sleep 600; true", poll: { intervalMs: 2_000, timeoutMs: 60_000 } },
    ]);
  });

  it("defaults the interval and the timeout when they are not given", async () => {
    enqueueCalls.length = 0;
    await run({ command: "true", description: "defaults" });

    expect(enqueueCalls[0]?.jobs[0]?.poll?.timeoutMs).toBe(SHELL_COMMAND_MAX_TIMEOUT_MS);
    expect(enqueueCalls[0]?.jobs[0]?.poll?.intervalMs).toBeGreaterThanOrEqual(
      WAIT_FOR_MIN_INTERVAL_MS,
    );
  });

  it("refuses when there is no conversation to wake", async () => {
    enqueueCalls.length = 0;
    const result = await run(
      { command: "true", description: "nobody to wake" },
      { conversationId: undefined },
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
