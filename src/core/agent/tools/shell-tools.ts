import { FileSystem } from "@effect/platform";
import { spawn } from "child_process";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../interfaces/fs";
import type { Tool } from "../../interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { createSanitizedEnv } from "../../utils/env-utils";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "./base-tool";
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
  /for\s+.*\s+in\s+.*\s+do\s+.*\s+done/, // shell loops

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

interface ExecuteCommandArgs extends Record<string, unknown> {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly timeout?: number;
}

/**
 * Create a tool for executing shell commands with user approval
 *
 * SECURITY WARNING: This tool can execute arbitrary commands on the system.
 * Only enable this feature if you trust the LLM and have proper approval mechanisms in place.
 * Consider the following security implications:
 * - Commands run with the same privileges as the jazz process
 * - Environment variables may be exposed to executed commands
 * - Network access is available to executed commands
 * - File system access is available within the working directory context
 */
export function createExecuteCommandTool(): Tool<FileSystemContextService> {
  return defineTool<FileSystemContextService, ExecuteCommandArgs>({
    name: "execute_command",
    description: formatApprovalRequiredDescription(
      "Execute a shell command on the system. Runs commands in a specified working directory with configurable timeout. Includes security checks to block dangerous operations (file deletion, system commands, etc.). All command executions are logged for security auditing. This tool requests user approval and does NOT perform the command execution directly. After the user confirms, you MUST call execute_command_approved with the exact arguments provided in the approval response.",
    ),
    tags: ["shell", "execution"],
    parameters: z
      .object({
        command: z
          .string()
          .min(1, "command cannot be empty")
          .describe("The shell command to execute (e.g., 'npm install', 'ls -la', 'git status')"),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory to execute the command in. If not provided, uses the current working directory.",
          ),
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional timeout in milliseconds (default: 30000). Commands that take longer will be terminated.",
          ),
      })
      .strict(),
    validate: (args) => {
      const schema = z
        .object({
          command: z.string().min(1),
          workingDirectory: z.string().optional(),
          timeout: z.number().int().positive().optional(),
        })
        .strict();
      const result = schema.safeParse(args);
      if (!result.success) {
        return { valid: false, errors: result.error.issues.map((i) => i.message) } as const;
      }
      return { valid: true, value: result.data as ExecuteCommandArgs } as const;
    },
    approval: {
      message: (args: ExecuteCommandArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const cwd = yield* shell.getCwd({
            agentId: context.agentId,
            ...(context.conversationId && { conversationId: context.conversationId }),
          });

          const workingDir = args.workingDirectory || cwd;
          const timeout = args.timeout || 30000;

          return `⚠️  COMMAND EXECUTION REQUEST ⚠️

Command: ${args.command}
Working Directory: ${workingDir}
Timeout: ${timeout}ms
Agent: ${context.agentId}

This command will be executed on your system. Please review it carefully and confirm if you want to proceed.

⚠️  WARNING: This tool can execute any command on your system. Only approve commands you trust! ⚠️

IMPORTANT: After getting user confirmation, you MUST call the execute_command_approved tool with these exact arguments: {"command": ${JSON.stringify(args.command)}, "workingDirectory": ${args.workingDirectory ? JSON.stringify(args.workingDirectory) : "undefined"}, "timeout": ${args.timeout ?? "undefined"}}`;
        }),
      errorMessage: "Command execution requires explicit user approval for security reasons.",
      execute: {
        toolName: "execute_command_approved",
        buildArgs: (args: Record<string, unknown>): Record<string, unknown> => {
          const typedArgs = args as ExecuteCommandArgs;
          return {
            command: typedArgs.command,
            workingDirectory: typedArgs.workingDirectory,
            timeout: typedArgs.timeout,
          };
        },
      },
    },
    handler: (_args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error:
          "Command execution requires approval. After user approval, call execute_command_approved tool.",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) {
        return "Command execution requires approval";
      }
      return undefined;
    },
  });
}

interface ExecuteCommandApprovedArgs extends Record<string, unknown> {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly timeout?: number;
}

/**
 * Create a tool for executing approved shell commands
 */
export function createExecuteCommandApprovedTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  return defineTool<FileSystem.FileSystem | FileSystemContextService, ExecuteCommandApprovedArgs>({
    name: "execute_command_approved",
    description: formatExecutionToolDescription(
      "Performs the actual shell command execution after user approval of execute_command. Performs additional security validation, runs the command with sanitized environment variables, and logs execution details. This tool should only be called after execute_command receives user approval.",
    ),
    hidden: true,
    parameters: z
      .object({
        command: z.string().min(1).describe("The shell command to execute"),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory to execute the command in"),
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds (default: 30000)"),
      })
      .strict(),
    validate: (args) => {
      const schema = z
        .object({
          command: z.string().min(1),
          workingDirectory: z.string().optional(),
          timeout: z.number().int().positive().optional(),
        })
        .strict();
      const result = schema.safeParse(args);
      if (!result.success) {
        return { valid: false, errors: result.error.issues.map((i) => i.message) } as const;
      }
      return { valid: true, value: result.data as ExecuteCommandApprovedArgs } as const;
    },
    handler: (args: ExecuteCommandApprovedArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;

        // Resolve and validate working directory (prevents path traversal attacks)
        const key = buildKeyFromContext(context);
        const workingDir = args.workingDirectory
          ? yield* shell.resolvePath(key, args.workingDirectory)
          : yield* shell.getCwd(key);
        const timeout = args.timeout || 30000;

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

                const child = spawn("sh", ["-c", command], {
                  cwd: workingDir,
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: timeout,
                  env: sanitizedEnv,
                  // Additional security options
                  detached: false,
                  uid: process.getuid ? process.getuid() : undefined,
                  gid: process.getgid ? process.getgid() : undefined,
                });

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

          // Log command execution for security auditing
          console.warn(`🔒 SECURITY LOG: Command executed by agent ${context.agentId}:`);
          console.warn({
            command: args.command,
            workingDirectory: workingDir,
            exitCode: result.exitCode,
            timestamp: new Date().toISOString(),
          });

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
  });
}
