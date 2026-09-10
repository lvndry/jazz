import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SHELL_COMMAND_MAX_TIMEOUT_MS, WAIT_FOR_MIN_INTERVAL_MS } from "@/core/constants/agent";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { createWaitTools, type WaitForOutcome } from "./wait-tools";

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
};

const testLayer = Layer.mergeAll(
  Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
  Layer.succeed(LoggerServiceTag, logger),
  NodeFileSystem.layer,
);

const tools = createWaitTools();

function run(args: Record<string, unknown>) {
  return Effect.runPromise(
    tools.execute
      .execute(args, {} as ToolExecutionContext)
      .pipe(Effect.provide(testLayer)) as Effect.Effect<ToolExecutionResult, Error, never>,
  );
}

function outcome(result: ToolExecutionResult): WaitForOutcome {
  return result.result as WaitForOutcome;
}

describe("wait_for", () => {
  it("returns as soon as the condition holds, without waiting out the interval", async () => {
    const started = Date.now();
    const result = await run({
      command: "true",
      description: "already true",
      intervalMs: 10_000,
      timeoutMs: 30_000,
    });

    expect(outcome(result).matched).toBe(true);
    expect(outcome(result).attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  /**
   * The condition becoming true partway through is the whole point, so the loop has to keep
   * checking rather than treat the first attempt as final.
   */
  it("keeps checking until a condition that starts false comes true", async () => {
    const counter = `${tmpdir()}/wait-for-counter-${String(process.pid)}`;
    rmSync(counter, { force: true });

    const result = await run({
      command: `count=$(cat ${counter} 2>/dev/null || echo 0); count=$((count+1)); echo $count > ${counter}; test $count -ge 3`,
      description: "true on the third check",
      intervalMs: WAIT_FOR_MIN_INTERVAL_MS,
      timeoutMs: 10_000,
    });

    expect(outcome(result).matched).toBe(true);
    expect(outcome(result).attempts).toBe(3);
    rmSync(counter, { force: true });
  });

  /**
   * Running out of budget is an answer the caller acts on — re-arm with register_trigger — so it
   * comes back as a successful tool call carrying timedOut, not as an error that discards the
   * last check's output.
   */
  it("reports a timeout as a result rather than an error, with the last output", async () => {
    const result = await run({
      command: "echo still-waiting; false",
      description: "never true",
      intervalMs: WAIT_FOR_MIN_INTERVAL_MS,
      timeoutMs: 1_200,
    });

    expect(result.success).toBe(true);
    expect(outcome(result).matched).toBe(false);
    expect(outcome(result).timedOut).toBe(true);
    expect(outcome(result).attempts).toBeGreaterThan(1);
    expect(outcome(result).stdout).toContain("still-waiting");
  });

  it("polls repeatedly within the budget rather than once per call", async () => {
    const result = await run({
      command: "false",
      description: "counts attempts",
      intervalMs: WAIT_FOR_MIN_INTERVAL_MS,
      timeoutMs: 2_000,
    });

    expect(outcome(result).attempts).toBeGreaterThanOrEqual(3);
  });

  it("refuses a budget beyond the ceiling instead of silently capping it", async () => {
    const result = await run({
      command: "true",
      description: "too long",
      timeoutMs: SHELL_COMMAND_MAX_TIMEOUT_MS + 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("register_trigger");
  });

  it("refuses an interval below the floor", async () => {
    const result = await run({
      command: "true",
      description: "too tight",
      intervalMs: WAIT_FOR_MIN_INTERVAL_MS - 1,
    });

    expect(result.success).toBe(false);
  });

  it("blocks a denylisted command before running it even once", async () => {
    const result = await run({ command: "sudo rm -rf /", description: "blocked" });

    expect(result.success).toBe(false);
  });

  it("suppresses the slow-tool warning, since blocking is the point", () => {
    expect(tools.execute.longRunning).toBe(true);
    expect(tools.execute.timeoutMs).toBe(SHELL_COMMAND_MAX_TIMEOUT_MS);
  });
});
