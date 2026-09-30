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
}

export interface PollUntilOutcome {
  readonly matched: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function pollUntilSuccess(input: PollUntilInput): Effect.Effect<PollUntilOutcome> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    let attempts = 0;
    let exitCode = -1;
    let stdout = "";
    let stderr = "";

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

      exitCode = attempt.exitCode;
      stdout = attempt.stdout;
      stderr = attempt.stderr;

      if (exitCode === 0) {
        return {
          matched: true,
          attempts,
          elapsedMs: Date.now() - startedAt,
          exitCode,
          stdout,
          stderr,
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
    };
  });
}
