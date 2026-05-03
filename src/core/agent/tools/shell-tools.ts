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

/**
 * Patterns that block obviously dangerous shell commands before execution.
 *
 * This is a defense-in-depth denylist, not a sandbox. It cannot stop a
 * determined attacker — variable expansion, base64 obfuscation, eval, and
 * other indirection paths can route around any string matcher. The intent is
 * to catch accidental destructive operations from a confused or malicious
 * model, while every command still requires explicit human approval upstream.
 *
 * See `shell-tools.security.test.ts` for the regression suite and the
 * documented set of known bypasses.
 */
export const FORBIDDEN_COMMANDS: readonly RegExp[] = [
  // File-system destruction (rm with any -r/-f flag combination, root paths,
  // home, or wildcards)
  /\brm\s+-[a-z]*[rf][a-z]*\s+/i, // rm -r / -f / -rf / -fr / -Rfv / -rfvI etc.
  /\brm\s+-[rfRF]\s+-[rfRF]\b/, // rm -r -f, rm -f -r
  /\brm\s+(?:.*\s+)?\/\s*$/, // rm targeting / (end of line, with or without other args)
  /\brm\s+(?:.*\s+)?\/(?:\s|$)/, // rm targeting / followed by space or end
  // rm targeting home — only when `~` starts an argument (after `rm` or
  // whitespace). Avoids false positives on Emacs-style backup files like
  // `rm file.txt~` or `rm src/*~`.
  /\brm\s+(?:.*?\s)?~/,
  /\brm\s+.*\*/, // rm with glob (no required space before *)

  // Privilege escalation
  /\bsudo\b/, // sudo in any position
  /\bsu\s+/, // su <user>
  /\bdoas\b/, // OpenBSD/Linux sudo alternative

  // Device-level destruction
  /\bmkfs\b/, // mkfs.<fs> formatting
  /\bdd\s+.*\bof=\/dev\//, // dd to a device, in any arg order
  /\bdd\s+.*\bif=\/dev\/(?:zero|random|urandom)\b/, // dd from /dev/zero etc.

  // Power / runlevel
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /\binit\s+[0-6]\b/,

  // Remote-code-fetch piped to a shell (the classic curl|sh footgun)
  /\bcurl\b.*\|\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
  /\bcurl\b\s+(?:-s\s+)?https?:\/\/.*\s*\|\s*\S/, // any pipe after curl URL
  /\bwget\b\s+(?:-q?O-?\s+)?https?:\/\/.*\s*\|\s*\S/, // wget -O- URL | ...

  // In-process code execution via interpreters
  /\b(?:python\d?|ruby|perl|node|deno|bun)\s+-[ce]\b/, // -c / -e flags
  /\b(?:bash|sh|zsh|fish|ksh|dash)\s+-c\b/,
  /\beval\s+/, // eval ... (anything)

  // Process manipulation
  /\bkill\s+(?:-9|-KILL|-SIGKILL)\b/,
  /\bpkill\b/,
  /\bkillall\b/,

  // Fork-bomb shapes — match a function defined as `<name>(){<...>:|<name>&...}`
  // The classic `:(){ :|:& };:` and any single-letter-renamed variant. The
  // function name can be `:` (non-word), so we anchor on the preceding
  // boundary instead of `\b` which doesn't fire before `:`.
  /(?:^|[\s;&|])\S+\s*\(\s*\)\s*\{[^}]*\|\s*\S+\s*&[^}]*\}\s*;\s*\S+/,
  /\bwhile\s+(?:true|:)(?:\s|;|$)/, // while true / while :

  // Permission widening
  /\bchmod\s+(?:0?777|a\+rwx|a=rwx|ugo\+rwx)\b/,
  /\bchmod\s+[ugoa]*[+=][rwxst]*s/, // setuid / setgid via symbolic mode
  /\bchmod\s+[246][0-7]{3}\b/, // setuid (4xxx) / setgid (2xxx) via numeric mode
  /\bchown\s+(?:root|0)\b/,

  // Filesystem mounting
  /\bmount\s+/,
  /\bumount\s+/,

  // Firewall / network surface manipulation
  /\biptables\b/,
  /\bnftables\b/,
  /\bufw\s+/,

  // Sensitive file disclosure — common readers targeting /etc/passwd, /etc/shadow, /etc/sudoers.
  /\b(?:cat|tac|less|more|head|tail|awk|grep|strings|od|xxd|nl|cut|sed)\s+[^|;&]*\/etc\/(?:passwd|shadow|sudoers)\b/,

  // Crypto-key disclosure — readers targeting private-key paths.
  /\b(?:cat|tac|less|more|head|tail|awk|grep|strings|od|xxd|nl)\s+[^|;&]*(?:\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys|known_hosts)|\.aws\/credentials|\.gnupg\/private-keys-v1\.d)\b/,

  // Sensitive file copying / exfiltration
  /\bcp\b[^|;&]*\/etc\/(?:passwd|shadow|sudoers)\b/,
  /\b(?:scp|rsync)\b[^|;&]*(?:\/etc\/(?:passwd|shadow|sudoers)|\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys)|\.aws\/credentials)\b/,

  // Writing backdoors into SSH authorized_keys
  /\b(?:echo|printf)\b[^|;&]*>>?\s*~\/\.ssh\/authorized_keys/,
  /\btee\b[^|;&]*~\/\.ssh\/authorized_keys/, // tee uses -a flag, not >>

  // rm safety bypass
  /\brm\b.*--no-preserve-root/,

  // Secure file wiping (unrecoverable)
  /\bshred\b/,
  /\btruncate\b/,
  /\bwipefs\b/,
  /\bblkdiscard\b/,
  /\bhdparm\b.*--security-erase\b/,

  // Reverse shells via netcat / socat
  /\bnc(?:at)?\b.*-[ec]\b/i,
  /\bsocat\b.*\bEXEC:/i,

  // Remote fetch then execute (two-step, without pipe — the pipe form is above)
  /\bcurl\b.*&&\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
  /\bwget\b.*&&\s*(?:sh|bash|zsh|fish|python\d?)\b/i,

  // Crontab manipulation (persistence / destruction)
  /\bcrontab\s+-[er]\b/,

  // Shell history wiping (cover-your-tracks)
  /\bhistory\s+-[cwda]\b/,

  // User account management — backdoor creation or account destruction
  /\b(?:useradd|userdel|usermod|groupadd|groupdel|groupmod)\b/,

  // Password changes on other accounts
  /\bpasswd\s+\S/,

  // sudoers editor
  /\bvisudo\b/,
];

/**
 * Pure check: does this command match any forbidden pattern?
 *
 * Exposed for testing and reuse. Callers must still treat the result as
 * advisory — see the doc on FORBIDDEN_COMMANDS about the limits of denylists.
 */
export function isDangerousCommand(command: string): boolean {
  return FORBIDDEN_COMMANDS.some((pattern) => pattern.test(command));
}

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
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in ms (default: 900000 = 15 min)"),
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
    timeoutMs: 15 * 60 * 1000, // 15 minutes — executor cap so long-running commands can complete
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
        const timeout = args.timeout || 900_000; // 15 minutes
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
        const timeout = args.timeout || 900_000; // 15 minutes

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
