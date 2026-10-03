/**
 * @fileoverview `wait_for` — watch a condition in the background. The call enqueues a one-job
 * batch whose worker reruns the check on an interval, returns at once, and the conversation is
 * woken when the condition holds or the time runs out, so a wait never holds a turn open.
 * Bounded by `SHELL_COMMAND_MAX_TIMEOUT_MS`; longer waits compose with `register_trigger`.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import {
  SHELL_COMMAND_MAX_TIMEOUT_MS,
  SHELL_COMMAND_TIMEOUT_MINUTES,
  WAIT_FOR_DEFAULT_INTERVAL_MS,
  WAIT_FOR_FIRST_CHECK_TIMEOUT_MS,
  WAIT_FOR_MIN_INTERVAL_MS,
} from "@/core/constants/agent";
import { JOB_REASON_MAX_LENGTH } from "@/core/constants/job-queue";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { JobQueueServiceTag, type JobQueueService } from "@/core/interfaces/job-queue-service";
import type { LoggerService } from "@/core/interfaces/logger";
import type { Tool } from "@/core/interfaces/tool-registry";
import { spawnJobWorker } from "@/core/jobs/spawn-job-worker";
import type { ToolExecutionResult } from "@/core/types";
import { createSanitizedEnv } from "@/core/utils/env";
import { toError } from "@/core/utils/errors";
import {
  defineApprovalTool,
  defineTool,
  makeZodValidator,
  type ApprovalToolPair,
} from "./base-tool";
import { tailForModel } from "./capped-output";
import { buildKeyFromContext } from "./context-utils";
import { denylistBlockedError, runShellCommand } from "./shell";
import { toolKnownSecrets } from "./tool-secrets";

export type WaitToolDeps =
  FileSystemContextService | JobQueueService | LoggerService | FileSystem.FileSystem;

function summarizeJobBatchId(batchId: string): string {
  return `wait_for batch ${batchId}`;
}

interface FirstCheck {
  readonly exitCode: number;
  readonly output: string;
}

/**
 * Run the condition once, in the same environment the background worker uses, so a check that
 * can never pass shows its real output now instead of after the whole wait. A check that outlasts
 * {@link WAIT_FOR_FIRST_CHECK_TIMEOUT_MS} is killed and reported as timed out.
 */
function runFirstCheck(command: string, workingDir: string): Effect.Effect<FirstCheck> {
  return Effect.gen(function* () {
    const known = yield* toolKnownSecrets();
    return yield* runShellCommand({
      command,
      workingDir,
      timeoutMs: WAIT_FOR_FIRST_CHECK_TIMEOUT_MS,
      env: createSanitizedEnv({}, []),
      redact: known,
    }).pipe(
      Effect.map((attempt) => ({
        exitCode: attempt.exitCode,
        output: tailForModel(attempt.stdout.trim() || attempt.stderr.trim()),
      })),
      Effect.catchAll((error) => Effect.succeed({ exitCode: -1, output: toError(error).message })),
    );
  });
}

function describeFirstCheck(check: FirstCheck): Record<string, unknown> {
  return {
    firstCheck: check,
    ...(check.output.length === 0
      ? {
          note:
            "The check printed nothing, so its progress is invisible. If it should, cancel and " +
            "rerun wait_for with a command that prints the value it tests before testing it.",
        }
      : {}),
  };
}

const waitForParameters = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, "command cannot be empty")
      .describe("Cheap, idempotent check that exits 0 once the condition holds."),
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .max(JOB_REASON_MAX_LENGTH)
      .describe("What is being waited for, shown at the approval gate."),
    intervalMs: z
      .number()
      .int()
      .min(WAIT_FOR_MIN_INTERVAL_MS)
      .optional()
      .describe(
        `Milliseconds between checks. Default ${String(WAIT_FOR_DEFAULT_INTERVAL_MS)}; match how fast the condition changes.`,
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(
        SHELL_COMMAND_MAX_TIMEOUT_MS,
        `timeoutMs cannot exceed ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}ms (${String(
          SHELL_COMMAND_TIMEOUT_MINUTES,
        )} minutes). Pass at most ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}, and call wait_for again if it times out.`,
      )
      .optional()
      .describe(
        `Milliseconds before giving up. Default and maximum ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}.`,
      ),
    workingDirectory: z.string().optional().describe("Defaults to the session working directory."),
  })
  .strict();

type WaitForArgs = z.infer<typeof waitForParameters>;

const cancelWaitForParameters = z
  .object({
    batchId: z.string().min(1).describe("Batch id from wait_for."),
  })
  .strict();

type CancelWaitForArgs = z.infer<typeof cancelWaitForParameters>;

export type WaitTools = ApprovalToolPair<WaitToolDeps> & {
  readonly cancelWaitFor: Tool<WaitToolDeps>;
};

function createCancelWaitForTool(): Tool<WaitToolDeps> {
  return defineTool<WaitToolDeps, CancelWaitForArgs>({
    name: "cancel_wait_for",
    disclosure: "internal",
    summary: "Cancel a pending wait_for by batch id (get the batch id from wait_for first).",
    description: "Cancel a pending wait_for by batch id.",
    parameters: cancelWaitForParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(cancelWaitForParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const jobQueueService = yield* JobQueueServiceTag;
        const outcome = yield* jobQueueService.cancelBatch(context.agentId, args.batchId);

        return {
          success: outcome.success,
          result: outcome.success ? { message: outcome.message } : null,
          ...(outcome.success ? {} : { error: outcome.message }),
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: toError(error).message,
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { message: string };
      return data.message;
    },
  });
}

export function createWaitTools(): WaitTools {
  const waitTools = defineApprovalTool<WaitToolDeps, WaitForArgs>({
    name: "wait_for",
    disclosure: "private",
    summary:
      "Watch for something to finish, appear, change, drop, arrive or come back up, checking as " +
      "often as every quarter second, in the background — you keep working and are woken when " +
      `it happens or after ${String(SHELL_COMMAND_TIMEOUT_MINUTES)} minutes at most. Cancel with cancel_wait_for using the batch id it returns.`,
    description:
      "Rerun a command in the background until it exits 0; use it for every wait-until check. " +
      "Runs one check right away: if it already exits 0 the call returns status `holds` and " +
      "nothing is scheduled; otherwise it returns that first check's exit code and output plus " +
      "a batchId, and keeps checking in the background while you keep working. Read the first " +
      "check's output to confirm the command tests what you mean. You are woken with the last " +
      "check's output when the command first exits 0 or when the time runs out. " +
      "Have the command print one short status line per check, such as " +
      "`tail -n 1 build.log; grep -q 'build finished' build.log`; the newest line shows in the " +
      "session while it waits. " +
      `Waits up to ${String(SHELL_COMMAND_TIMEOUT_MINUTES)} minutes.`,
    parameters: waitForParameters,
    riskLevel: "unknown",
    validate: makeZodValidator(waitForParameters),
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

The command runs repeatedly and unattended, in the background, until it succeeds or the time runs out. Only approve a command you trust to run that many times.`);
    },
    approvalErrorMessage: "Waiting on a repeated command requires explicit user approval.",
    handler: (args, context) =>
      Effect.gen(function* () {
        const blocked = denylistBlockedError(args.command);
        if (blocked) {
          return { success: false, result: null, error: blocked } satisfies ToolExecutionResult;
        }

        if (context.conversationId === undefined) {
          return {
            success: false,
            result: null,
            error: "No conversation to resume — wait_for is unavailable in this context.",
          } satisfies ToolExecutionResult;
        }

        const shell = yield* FileSystemContextServiceTag;
        const jobQueueService = yield* JobQueueServiceTag;
        const key = buildKeyFromContext(context);
        const workingDir = args.workingDirectory
          ? yield* shell.resolvePath(key, args.workingDirectory)
          : yield* shell.getCwd(key);

        const firstCheck = yield* runFirstCheck(args.command, workingDir);
        if (firstCheck.exitCode === 0) {
          return {
            success: true,
            result: { status: "holds", output: firstCheck.output },
          } satisfies ToolExecutionResult;
        }

        const intervalMs = args.intervalMs ?? WAIT_FOR_DEFAULT_INTERVAL_MS;
        const timeoutMs = args.timeoutMs ?? SHELL_COMMAND_MAX_TIMEOUT_MS;

        const outcome = yield* jobQueueService.enqueueBatch(
          context.agentId,
          context.conversationId,
          [{ command: args.command, poll: { intervalMs, timeoutMs } }],
          { workingDir, reason: args.description },
        );

        if (!outcome.success) {
          return {
            success: false,
            result: null,
            error: outcome.message,
          } satisfies ToolExecutionResult;
        }

        const worker = yield* spawnJobWorker(context.agentId);

        return {
          success: true,
          result: {
            batchId: outcome.batch.id,
            status: "watching",
            ...describeFirstCheck(firstCheck),
            ...(worker.spawned
              ? {}
              : {
                  warning:
                    `No background worker could be started (${worker.reason ?? "unknown reason"}), ` +
                    "so this wait only runs if `jazz daemon` is running. Do not assume you " +
                    "will be woken — tell the person.",
                }),
          },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: toError(error).message,
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { batchId?: string; status: string };
      if (data.batchId === undefined) {
        return "The condition already holds";
      }
      return `Watching in the background (${summarizeJobBatchId(data.batchId)})`;
    },
  });

  return {
    ...waitTools,
    cancelWaitFor: createCancelWaitForTool(),
  };
}
