/**
 * @fileoverview `wait_for` — block on a condition inside a single tool call.
 *
 * The gap this fills: watching something resolve used to cost one model turn per look. A caller
 * asked to catch a transition quickly had no way to check often, because "check every second"
 * meant a model run every second, and the tools that suspend the run instead (`register_trigger`)
 * only wake on a schedule measured in minutes. So a caller either polled coarsely and missed the
 * moment, or chained `execute_command` calls with `sleep` in between and paid a turn for each.
 *
 * Here the polling happens inside one tool call: the predicate runs, the fiber sleeps, the
 * predicate runs again, and the model is only involved once — when the condition is met, or when
 * the budget runs out. Cheap enough to poll at sub-second intervals.
 *
 * What this deliberately does *not* do is outlast its budget. `SHELL_COMMAND_MAX_TIMEOUT_MS`
 * bounds it, the same as any other command, because a longer block means a model turn held open
 * with the caller unable to interject and everything lost if the process dies. Waits that outlast
 * that are `register_trigger`'s job: it suspends the run and resumes it later. The two compose —
 * poll tightly inside the budget, re-arm across it.
 */
import { FileSystem } from "@effect/platform";
import { Duration, Effect } from "effect";
import { z } from "zod";
import {
  SHELL_COMMAND_MAX_TIMEOUT_MS,
  SHELL_COMMAND_TIMEOUT_MINUTES,
  WAIT_FOR_DEFAULT_INTERVAL_MS,
  WAIT_FOR_MIN_INTERVAL_MS,
} from "@/core/constants/agent";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionResult } from "@/core/types";
import { createSanitizedEnv } from "@/core/utils/env";
import { defineApprovalTool, makeZodValidator, type ApprovalToolPair } from "./base-tool";
import { tailForModel } from "./capped-output";
import { buildKeyFromContext } from "./context-utils";
import { denylistBlockedError, runShellCommand } from "./shell-tools";

export type WaitToolDeps = FileSystemContextService | LoggerService | FileSystem.FileSystem;

const waitForParameters = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, "command cannot be empty")
      .describe(
        "Shell command run repeatedly as the condition. Exit code 0 means the condition is met " +
          "and the wait ends; any other exit code means keep waiting. Write it to be cheap and " +
          "idempotent — it may run hundreds of times.",
      ),
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .describe("Short explanation of what is being waited for, shown at the approval gate."),
    intervalMs: z
      .number()
      .int()
      .min(WAIT_FOR_MIN_INTERVAL_MS)
      .optional()
      .describe(
        `How long to wait between checks, in milliseconds. Default ${String(
          WAIT_FOR_DEFAULT_INTERVAL_MS,
        )}, minimum ${String(WAIT_FOR_MIN_INTERVAL_MS)}. Match it to how fast the thing actually ` +
          `changes; each check is a process spawn.`,
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(
        SHELL_COMMAND_MAX_TIMEOUT_MS,
        `timeoutMs cannot exceed ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}ms (${String(
          SHELL_COMMAND_TIMEOUT_MINUTES,
        )} minutes). To keep waiting past that, let this call return and use register_trigger.`,
      )
      .optional()
      .describe(
        `How long to keep checking before giving up, in milliseconds. Default and maximum ` +
          `${String(SHELL_COMMAND_MAX_TIMEOUT_MS)} (${String(
            SHELL_COMMAND_TIMEOUT_MINUTES,
          )} minutes). Running out is not an error — you get timedOut: true and the last check's ` +
          `output, so you can re-arm with register_trigger.`,
      ),
    workingDirectory: z
      .string()
      .optional()
      .describe("Directory to run the command in. Defaults to the session working directory."),
  })
  .strict();

type WaitForArgs = z.infer<typeof waitForParameters>;

export interface WaitForOutcome {
  readonly matched: boolean;
  readonly timedOut: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function createWaitTools(): ApprovalToolPair<WaitToolDeps> {
  return defineApprovalTool<WaitToolDeps, WaitForArgs>({
    name: "wait_for",
    disclosure: "private",
    summary:
      "Block until a condition comes true, checking as often as every quarter second — wait for " +
      "something to finish, appear, change, drop, arrive or come back up, without spending a " +
      "turn per look. Capped at " +
      `${String(SHELL_COMMAND_TIMEOUT_MINUTES)} minutes.`,
    description:
      "Run a command over and over until it exits 0, then return — one tool call, one model " +
      "turn, however many checks it took. Use this instead of chaining execute_command with " +
      "sleeps, and instead of waking yourself repeatedly for something that will resolve in " +
      "minutes.\n\n" +
      `Bounded at ${String(SHELL_COMMAND_TIMEOUT_MINUTES)} minutes like any other command. If ` +
      "the budget runs out you get timedOut: true plus the last check's output rather than an " +
      "error — register_trigger from there to keep waiting, which is the tool for anything " +
      "open-ended or longer than the cap.\n\n" +
      "Pick intervalMs to match how fast the thing changes: sub-second to catch a transition the " +
      "moment it happens, tens of seconds for a build. The predicate runs as a real process each " +
      "time, so keep it cheap — one status check, not a full test suite.",
    parameters: waitForParameters,
    riskLevel: "unknown",
    validate: makeZodValidator(waitForParameters),
    timeoutMs: SHELL_COMMAND_MAX_TIMEOUT_MS,
    longRunning: true,
    approvalMessage: (args) => {
      const blocked = denylistBlockedError(args.command);
      if (blocked) {
        return Effect.succeed({
          skipApproval: true as const,
          toolResult: { success: false, result: null, error: blocked } as const,
        });
      }

      const intervalMs = args.intervalMs ?? WAIT_FOR_DEFAULT_INTERVAL_MS;
      const timeoutMs = args.timeoutMs ?? SHELL_COMMAND_MAX_TIMEOUT_MS;
      const maxAttempts = Math.floor(timeoutMs / intervalMs) + 1;

      return Effect.succeed(`Wait for: ${args.description}

Condition command: ${args.command}
Checked every: ${String(intervalMs)}ms
Giving up after: ${String(Math.round(timeoutMs / 1000))}s
Worst case: about ${String(maxAttempts)} runs of that command

The command runs repeatedly and unattended until it succeeds or the time runs out. Only approve a command you trust to run that many times.`);
    },
    approvalErrorMessage: "Waiting on a repeated command requires explicit user approval.",
    handler: (args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const key = buildKeyFromContext(context);
        const workingDir = args.workingDirectory
          ? yield* shell.resolvePath(key, args.workingDirectory)
          : yield* shell.getCwd(key);

        const blocked = denylistBlockedError(args.command);
        if (blocked) {
          return { success: false, result: null, error: blocked } satisfies ToolExecutionResult;
        }

        const intervalMs = args.intervalMs ?? WAIT_FOR_DEFAULT_INTERVAL_MS;
        const timeoutMs = args.timeoutMs ?? SHELL_COMMAND_MAX_TIMEOUT_MS;
        const envAllowlist = context.parentAgent?.config.envAllowlist ?? [];
        const env = createSanitizedEnv(
          typeof context.timezone === "string" && context.timezone.length > 0
            ? { TZ: context.timezone }
            : {},
          envAllowlist,
        );

        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        let attempts = 0;
        let lastExitCode = -1;
        let lastStdout = "";
        let lastStderr = "";

        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;

          attempts += 1;
          // A hung predicate must not eat a budget that belongs to the wait, so its own deadline
          // is whatever is left rather than the full cap.
          const attempt = yield* runShellCommand({
            command: args.command,
            workingDir,
            timeoutMs: remainingMs,
            env,
          }).pipe(
            Effect.catchAll((error: unknown) =>
              Effect.succeed({
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: -1,
              }),
            ),
          );

          lastExitCode = attempt.exitCode;
          lastStdout = attempt.stdout;
          lastStderr = attempt.stderr;

          if (attempt.exitCode === 0) {
            return {
              success: true,
              result: {
                matched: true,
                timedOut: false,
                attempts,
                elapsedMs: Date.now() - startedAt,
                exitCode: 0,
                stdout: tailForModel(attempt.stdout),
                stderr: tailForModel(attempt.stderr),
              } satisfies WaitForOutcome,
            } satisfies ToolExecutionResult;
          }

          const sleepMs = Math.min(intervalMs, deadline - Date.now());
          if (sleepMs <= 0) break;
          yield* Effect.sleep(Duration.millis(sleepMs));
        }

        // Running out of time is a real answer, not a failure: the caller needs to know the
        // condition did not come true so it can decide whether to re-arm, and needs the last
        // check's output to decide. Reporting it as an error would throw both away.
        return {
          success: true,
          result: {
            matched: false,
            timedOut: true,
            attempts,
            elapsedMs: Date.now() - startedAt,
            exitCode: lastExitCode,
            stdout: tailForModel(lastStdout),
            stderr: tailForModel(lastStderr),
          } satisfies WaitForOutcome,
        } satisfies ToolExecutionResult;
      }),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const outcome = result.result as WaitForOutcome;
      const seconds = Math.round(outcome.elapsedMs / 1000);
      return outcome.matched
        ? `Condition met after ${String(seconds)}s (${String(outcome.attempts)} checks)`
        : `Gave up after ${String(seconds)}s (${String(outcome.attempts)} checks)`;
    },
  });
}
