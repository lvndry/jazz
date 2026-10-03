/**
 * @fileoverview Rerun a shell command until it exits 0 or a deadline passes — the loop behind
 * background `wait_for` jobs, run by the job worker.
 */
import { Duration, Effect } from "effect";
import { toError } from "@/core/utils/errors";
import { runShellCommand } from "./shell";

export interface PollUntilInput {
  readonly command: string;
  readonly workingDir: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  /** Called after every check, matched or not, before the wait for the next one. */
  readonly onCheck?: (check: PollCheck) => Effect.Effect<void>;
}

export interface PollCheck {
  readonly attempts: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PollUntilOutcome {
  readonly matched: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  /**
   * `exitCode`, `stdout` and `stderr` are the last check that ran to completion; a check the
   * deadline killed midway is dropped, so its timeout note never hides what the check saw.
   */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when more than one check ran and every one returned the same exit code and output: the
   * check never reacted to anything, which usually means it cannot pass rather than that the
   * thing it watches is slow.
   */
  readonly unchanged: boolean;
}

export function pollUntilSuccess(input: PollUntilInput): Effect.Effect<PollUntilOutcome> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    let attempts = 0;
    let exitCode = -1;
    let stdout = "";
    let stderr = "";
    let firstResult: string | undefined;
    let everyResultIdentical = true;

    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      attempts += 1;
      const attempt = yield* runShellCommand({
        command: input.command,
        workingDir: input.workingDir,
        timeoutMs: remainingMs,
        env: input.env,
      }).pipe(
        Effect.catchAll((error: unknown) =>
          Effect.succeed({ stdout: "", stderr: toError(error).message, exitCode: -1 }),
        ),
      );

      const cutOffByDeadline = attempt.exitCode !== 0 && Date.now() >= deadline;
      if (cutOffByDeadline && attempts > 1) {
        attempts -= 1;
        break;
      }

      exitCode = attempt.exitCode;
      stdout = attempt.stdout;
      stderr = attempt.stderr;
      const result = JSON.stringify([exitCode, stdout, stderr]);
      firstResult ??= result;
      if (result !== firstResult) {
        everyResultIdentical = false;
      }

      if (input.onCheck !== undefined) {
        yield* input.onCheck({ attempts, exitCode, stdout, stderr });
      }

      if (exitCode === 0) {
        return {
          matched: true,
          attempts,
          elapsedMs: Date.now() - startedAt,
          exitCode,
          stdout,
          stderr,
          unchanged: false,
        };
      }

      const sleepMs = Math.min(input.intervalMs, deadline - Date.now());
      if (sleepMs <= 0) {
        break;
      }
      yield* Effect.sleep(Duration.millis(sleepMs));
    }

    return {
      matched: false,
      attempts,
      elapsedMs: Date.now() - startedAt,
      exitCode,
      stdout,
      stderr,
      unchanged: attempts > 1 && everyResultIdentical,
    };
  });
}
