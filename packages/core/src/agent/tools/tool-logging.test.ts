/**
 * Checks that tool diagnostics contain useful lifecycle data without copying
 * tool arguments, results, summaries, or errors into the default log stream.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import {
  logToolExecutionApproval,
  logToolExecutionError,
  logToolExecutionStart,
  logToolExecutionSuccess,
} from "./tool-logging";

type RecordEntry = {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly meta?: Record<string, unknown>;
};

function recordingLogger(entries: RecordEntry[]): LoggerService {
  const record =
    (level: RecordEntry["level"]) => (message: string, meta?: Record<string, unknown>) =>
      Effect.sync(() => {
        entries.push({ level, message, ...(meta ? { meta } : {}) });
      });
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    writeToFile: (_level, _message, _meta) => Effect.void,
    logToolCall: (_name, _args) => Effect.void,
    setLogGroup: (_group) => Effect.void,
    clearLogGroup: () => Effect.void,
    pushLogGroup: (_group) => Effect.void,
    popLogGroup: () => Effect.void,
  };
}

describe("tool execution diagnostics", () => {
  it("uses operational severity and excludes content-bearing inputs", async () => {
    const entries: RecordEntry[] = [];
    const secret = "secret-value-in-content";
    const program = Effect.gen(function* () {
      yield* logToolExecutionStart("execute_command", { command: `echo ${secret}` });
      yield* logToolExecutionSuccess("execute_command", 42, secret, { output: secret });
      yield* logToolExecutionApproval("execute_command", 5, `approve ${secret}`);
      yield* logToolExecutionError("execute_command", 7, `failed: ${secret}`);
    });

    await Effect.runPromise(
      program.pipe(Effect.provideService(LoggerServiceTag, recordingLogger(entries))),
    );

    expect(entries.map((entry) => entry.level)).toEqual(["debug", "info", "info", "error"]);
    expect(entries.map((entry) => entry.meta?.["eventName"])).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
      "tool.approval.required",
      "tool.execution.failed",
    ]);
    expect(entries[1]?.meta).toMatchObject({ durationMs: 42 });
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it("does not copy a model supplied invalid tool name into an error record", async () => {
    const entries: RecordEntry[] = [];
    const secretName = "private_token_value";
    await Effect.runPromise(
      logToolExecutionError(secretName, 1, "failed").pipe(
        Effect.provideService(LoggerServiceTag, recordingLogger(entries)),
      ),
    );
    expect(JSON.stringify(entries)).not.toContain(secretName);
    expect(entries[0]?.meta).not.toHaveProperty("toolName");
  });
});
