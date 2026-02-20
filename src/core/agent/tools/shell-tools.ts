import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { createSanitizedEnv } from "@/core/utils/env-utils";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";

// Enhanced security checks for potentially dangerous commands
const FORBIDDEN_COMMANDS = [
  // File system destruction
  /rm\s+-rf\s+/, // rm -rf (any path)
  /rm\s+.*\s+\//, // rm with root path
  /rm\s+.*\s+~/, // rm with home directory
  /rm\s+.*\s+\*/, // rm with wildcards

  // System commands
  /sudo\s+/, // sudo commands
  /su\s+/, // su commands
  /mkfs\./, // format filesystem
  /dd\s+if=.*of=\/dev\//, // dd to device
  /shutdown/, // shutdown commands
  /reboot/, // reboot commands
  /halt/, // halt commands
  /poweroff/, // poweroff commands
  /init\s+[0-6]/, // init runlevel changes

  // Network and code execution
  /curl\s+.*\s*\|/, // curl with pipe
  /wget\s+.*\s*\|/, // wget with pipe
  /python\s+-c/, // python code execution
  /node\s+-e/, // node code execution
  /bash\s+-c/, // bash code execution
  /sh\s+-c/, // shell code execution

  // Process manipulation
  /kill\s+-9/, // force kill processes
  /pkill\s+/, // kill processes by name
  /killall\s+/, // kill all processes

  // Fork bombs and resource exhaustion
  /:\(\)\s*{/, // fork bomb pattern
  /while\s+true/, // infinite loops
  /for\s+\S+\s+in\s+\S+\s+do\s+\S+\s+done/, // shell loops (uses \S+ to avoid backtracking)

  // File system manipulation
  /chmod\s+777/, // overly permissive permissions
  /chown\s+root/, // changing ownership to root
  /mount\s+/, // mounting filesystems
  /umount\s+/, // unmounting filesystems

  // Network manipulation
  /iptables/, // firewall manipulation
  /ufw\s+/, // ubuntu firewall
  /netstat\s+-tulpn/, // network information gathering
  /ss\s+-tulpn/, // socket statistics

  // System information gathering
  /cat\s+\/etc\/passwd/, // reading password file
  /cat\s+\/etc\/shadow/, // reading shadow file
  /cat\s+\/etc\/hosts/, // reading hosts file
  /ps\s+aux/, // process listing
  /top\s*$/, // system monitor
  /htop\s*$/, // system monitor
];

type ExecuteCommandArgs = {
  command: string;
  description: string;
  workingDirectory?: string;
  timeout?: number;
};

const executeCommandParameters = z
  .object({
    command: z.string().min(1, "command cannot be empty").describe("Shell command to execute"),
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .describe("Human-readable explanation of what the command will do"),
    workingDirectory: z.string().optional().describe("Working directory (defaults to cwd)"),
    timeout: z.number().int().positive().optional().describe("Timeout in ms (default: 30000)"),
  })
  .strict();

type ShellCommandDeps = FileSystem.FileSystem | FileSystemContextService | LoggerService;

/**
 * Create shell command tools (approval + execution pair).
 *
 * SECURITY WARNING: This tool can execute arbitrary commands on the system.
 * Consider the following security implications:
 * - Commands run with the same privileges as the jazz process
 * - Environment variables may be exposed to executed commands
 * - Network access is available to executed commands
 * - File system access is available within the working directory context
 */
export function createShellCommandTools(): ApprovalToolPair<ShellCommandDeps> {
  const config: ApprovalToolConfig<ShellCommandDeps, ExecuteCommandArgs> = {
    name: "execute_command",
    description: "Execute a shell command. Use only when no dedicated tool exists.",
    tags: ["shell", "execution"],
    parameters: executeCommandParameters,
    validate: (args) => {
      const result = executeCommandParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as ExecuteCommandArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: ExecuteCommandArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd({
          agentId: context.agentId,
          ...(context.conversationId && { conversationId: context.conversationId }),
        });

        const workingDir = args.workingDirectory || cwd;
        const timeout = args.timeout || 30_000;
        const description = args.description.trim();

        return `Command: ${args.command}
Description: ${description}
Working Directory: ${workingDir}
Timeout: ${timeout}ms

This command will be executed on your system. Only approve commands you trust.`;
      }),

    approvalErrorMessage: "Command execution requires explicit user approval for security reasons.",

    handler: (args: ExecuteCommandArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const logger = yield* LoggerServiceTag;

        // Resolve and validate working directory (prevents path traversal attacks)
        const key = buildKeyFromContext(context);
        const workingDir = args.workingDirectory
          ? yield* shell.resolvePath(key, args.workingDirectory)
          : yield* shell.getCwd(key);
        const timeout = args.timeout || 30_000;

        // Basic safety checks
        const command = args.command.trim();
        if (!command) {
          return {
            success: false,
            result: null,
            error: "Command cannot be empty",
          } as ToolExecutionResult;
        }

        const isDangerous = FORBIDDEN_COMMANDS.some((pattern) => pattern.test(command));
        if (isDangerous) {
          return {
            success: false,
            result: null,
            error:
              "Command appears to be potentially dangerous and was blocked for safety. If you need to run this command, please execute it manually.",
          } as ToolExecutionResult;
        }

        try {
          // Sanitize environment variables for security
          const sanitizedEnv = createSanitizedEnv();

          const result = yield* Effect.promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>(
            () =>
              new Promise((resolve, reject) => {
                let resolved = false;
                let stdout = "";
                let stderr = "";

                let child;
                try {
                  child = spawn("sh", ["-c", command], {
                    cwd: workingDir,
                    stdio: ["ignore", "pipe", "pipe"],
                    timeout: timeout,
                    env: sanitizedEnv,
                    // Additional security options
                    detached: false,
                    uid: process.getuid ? process.getuid() : undefined,
                    gid: process.getgid ? process.getgid() : undefined,
                  });
                } catch (spawnError) {
                  reject(spawnError instanceof Error ? spawnError : new Error(String(spawnError)));
                  return;
                }

                if (child.stdout) {
                  child.stdout.on("data", (data: Buffer) => {
                    stdout += data.toString();
                  });
                }

                if (child.stderr) {
                  child.stderr.on("data", (data: Buffer) => {
                    stderr += data.toString();
                  });
                }

                // Handle timeout
                let timeoutId: NodeJS.Timeout | null = null;

                const cleanup = (): void => {
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }
                };

                timeoutId = setTimeout(() => {
                  if (!resolved) {
                    child.kill("SIGKILL");
                    resolved = true;
                    reject(new Error(`Command timed out after ${timeout}ms`));
                  }
                }, timeout);

                child.on("error", (error) => {
                  cleanup();
                  if (!resolved) {
                    resolved = true;
                    reject(error);
                  }
                });

                child.on("close", (code) => {
                  cleanup();
                  if (!resolved) {
                    resolved = true;
                    resolve({
                      stdout: stdout.trim(),
                      stderr: stderr.trim(),
                      exitCode: code || 0,
                    });
                  }
                });
              }),
          ).pipe(
            Effect.catchAll((error: unknown) =>
              Effect.succeed({
                stdout: "",
                stderr: "",
                exitCode: -1,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );

          // Check if this was a timeout or other error
          if ("error" in result) {
            return {
              success: false,
              result: null,
              error: result.error,
            } as ToolExecutionResult;
          }

          const exitMsg = `Command executed. Exit code: ${result.exitCode}`;
          yield* logger.info(exitMsg);
          const output = (result.stdout + (result.stderr ? `\nERR: ${result.stderr}` : "")).trim();
          if (output) {
            yield* logger.info(`Output: ${output}`);
          }

          return {
            success: true,
            result: {
              command: args.command,
              workingDirectory: workingDir,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              success: result.exitCode === 0,
            },
          } as ToolExecutionResult;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: null,
            error: `Command execution failed: ${errorMessage}`,
          } as ToolExecutionResult;
        }
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) {
        return "Command execution failed";
      }
      const data = result.result;
      if (data && typeof data === "object" && "command" in data && "exitCode" in data) {
        const command = data.command as string;
        const exitCode = data.exitCode as number;
        const success = exitCode === 0;
        return `Command "${command}" ${success ? "succeeded" : "failed"} (exit code: ${exitCode})`;
      }
      return "Command executed";
    },
  };

  return defineApprovalTool<ShellCommandDeps, ExecuteCommandArgs>(config);
}
