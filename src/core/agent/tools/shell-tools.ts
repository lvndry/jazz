import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { createSanitizedEnv } from "@/core/utils/env";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "./base-tool";
import {
  bindCappedStdio,
  DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
  formatCappedStream,
} from "./capped-output";
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
/** An inline `mktemp` command substitution — `$(mktemp …)` or `` `mktemp …` ``. */
const MKTEMP_INLINE = /\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`/g;

/** A placeholder standing in for an inline `mktemp` so it survives whitespace splitting. */
const MKTEMP_SENTINEL = "MKTEMP_TEMPDIR_SENTINEL";

/**
 * Variable assignments whose value comes from `mktemp` (either `$(mktemp …)` or
 * a backtick form), e.g. `tmp="$(mktemp -d)"`. Global flag so `matchAll` walks
 * every assignment in a multi-line command.
 */
const MKTEMP_ASSIGNMENT = /(\w+)=["']?(?:\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`)["']?/g;

function collectMktempVars(command: string): Set<string> {
  const vars = new Set<string>();
  for (const match of command.matchAll(MKTEMP_ASSIGNMENT)) {
    const name = match[1];
    if (name) vars.add(name);
  }
  return vars;
}

/**
 * Is `token` (already normalized — quotes stripped, inline `mktemp` replaced
 * with {@link MKTEMP_SENTINEL}) a temp target: an inline `mktemp`, a
 * `$TMPDIR`/`${TMPDIR}` path, or a `$var`/`${var}` (optionally with a
 * `/subpath`) whose value was assigned from `mktemp` earlier in the command?
 */
function isTempPathToken(token: string, mktempVars: Set<string>): boolean {
  if (token === MKTEMP_SENTINEL) return true; // inline $(mktemp …) / `mktemp …`
  if (/^\$\{?TMPDIR\}?(?:\/.*)?$/.test(token)) return true; // $TMPDIR or ${TMPDIR}[/…]
  const varName = token.match(/^\$\{?(\w+)\}?(?:\/.*)?$/)?.[1]; // $var / ${var}[/…]
  return varName !== undefined && mktempVars.has(varName);
}

/**
 * True when every destructive `rm` in the command targets only temp locations
 * created via `mktemp` (directly or through a variable) or under `$TMPDIR`.
 *
 * Lets routine temp-dir cleanup — `tmp="$(mktemp -d)"; …; rm -rf "$tmp"` — pass
 * the denylist, while `rm -rf` against a real path (or a mix of temp and real
 * targets) stays blocked. Deliberately narrow: literal `/tmp/…` paths are NOT
 * exempted, matching the existing policy that treats them as dangerous.
 */
function isTempCleanupRm(command: string): boolean {
  const mktempVars = collectMktempVars(command);
  const rmInvocations = command.match(/\brm\b[^\n;&|]*/g);
  if (!rmInvocations || rmInvocations.length === 0) return false;
  return rmInvocations.every((invocation) => {
    const targets = invocation
      .slice(2) // drop the leading "rm"
      .replace(/['"]/g, "") // shell quoting can sit mid-token (e.g. "$dir"/*)
      .replace(MKTEMP_INLINE, ` ${MKTEMP_SENTINEL} `) // keep inline mktemp as one token
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith("-"));
    return targets.length > 0 && targets.every((token) => isTempPathToken(token, mktempVars));
  });
}

/**
 * A named carve-out for a forbidden rule. When a command trips a rule, it is
 * still allowed if any of the rule's exemptions matches the command. Add new
 * entries here (and reference them from a rule's `exemptions`) to grow the set
 * of safe exceptions without special-casing the matcher.
 */
type CommandExemption = {
  /** Stable identifier, handy for logging/telemetry and tests. */
  readonly name: string;
  /** True when this exemption applies to the given command. */
  readonly matches: (command: string) => boolean;
};

/**
 * Temp-dir cleanup: an `rm` whose every target is a mktemp/$TMPDIR temp path.
 * Lets `tmp="$(mktemp -d)"; …; rm -rf "$tmp"` through without opening up
 * `rm -rf` against real paths.
 */
const TEMP_CLEANUP_EXEMPTION: CommandExemption = {
  name: "temp-cleanup",
  matches: isTempCleanupRm,
};

/**
 * A single denylist entry: the pattern that flags a command, plus a short,
 * agent-readable `reason` explaining *why* it was blocked. The reason is
 * surfaced verbatim in the tool error so the model (and user) learn the exact
 * cause — e.g. "`rm` with a recursive/force flag" — instead of a generic
 * "this command was blocked".
 */
type ForbiddenRule = {
  readonly pattern: RegExp;
  readonly reason: string;
  /**
   * Named carve-outs: if any listed exemption matches the command, this rule is
   * skipped. Lets a rule stay broad while allowing known-safe shapes (e.g. the
   * {@link TEMP_CLEANUP_EXEMPTION} for temp-dir cleanup).
   */
  readonly exemptions?: readonly CommandExemption[];
};

export const FORBIDDEN_COMMANDS: readonly ForbiddenRule[] = [
  // File-system destruction (rm with any -r/-f flag combination, root paths,
  // home, or wildcards)
  {
    pattern: /\brm\s+-[a-z]*[rf][a-z]*\s+/i, // rm -r / -f / -rf / -fr / -Rfv / -rfvI etc.
    reason:
      "`rm` with a recursive/force flag (-r/-f) is on the blocked list (exempt only when the target is a mktemp/$TMPDIR temp path)",
    exemptions: [TEMP_CLEANUP_EXEMPTION],
  },
  {
    pattern: /\brm\s+-[rfRF]\s+-[rfRF]\b/, // rm -r -f, rm -f -r
    reason:
      "`rm` with split recursive/force flags (-r -f) is on the blocked list (exempt only when the target is a mktemp/$TMPDIR temp path)",
    exemptions: [TEMP_CLEANUP_EXEMPTION],
  },
  {
    pattern: /\brm\s+(?:.*\s+)?\/\s*$/, // rm targeting / (end of line, with or without other args)
    reason: "`rm` targeting the filesystem root (/) is on the blocked list",
  },
  {
    pattern: /\brm\s+(?:.*\s+)?\/(?:\s|$)/, // rm targeting / followed by space or end
    reason: "`rm` targeting the filesystem root (/) is on the blocked list",
  },
  // rm targeting home — only when `~` starts an argument (after `rm` or
  // whitespace). Avoids false positives on Emacs-style backup files like
  // `rm file.txt~` or `rm src/*~`.
  {
    pattern: /\brm\s+(?:.*?\s)?~/,
    reason: "`rm` targeting the home directory (~) is on the blocked list",
  },
  {
    pattern: /\brm\s+.*\*/, // rm with glob (no required space before *)
    reason:
      "`rm` with a wildcard (*) is on the blocked list (exempt only when the target is a mktemp/$TMPDIR temp path)",
    exemptions: [TEMP_CLEANUP_EXEMPTION],
  },

  // Privilege escalation
  { pattern: /\bsudo\b/, reason: "`sudo` (privilege escalation) is on the blocked list" },
  { pattern: /\bsu\s+/, reason: "`su` (switch user) is on the blocked list" },
  { pattern: /\bdoas\b/, reason: "`doas` (privilege escalation) is on the blocked list" },

  // Device-level destruction
  { pattern: /\bmkfs\b/, reason: "`mkfs` (filesystem formatting) is on the blocked list" },
  {
    pattern: /\bdd\s+.*\bof=\/dev\//, // dd to a device, in any arg order
    reason: "`dd` writing to a device (of=/dev/...) is on the blocked list",
  },
  {
    pattern: /\bdd\s+.*\bif=\/dev\/(?:zero|random|urandom)\b/, // dd from /dev/zero etc.
    reason: "`dd` reading from /dev/zero|random|urandom is on the blocked list",
  },

  // Power / runlevel
  { pattern: /\bshutdown\b/, reason: "`shutdown` (power/runlevel change) is on the blocked list" },
  { pattern: /\breboot\b/, reason: "`reboot` (power/runlevel change) is on the blocked list" },
  { pattern: /\bhalt\b/, reason: "`halt` (power/runlevel change) is on the blocked list" },
  { pattern: /\bpoweroff\b/, reason: "`poweroff` (power/runlevel change) is on the blocked list" },
  { pattern: /\binit\s+[0-6]\b/, reason: "`init <runlevel>` is on the blocked list" },

  // Remote-code-fetch piped to a shell (the classic curl|sh footgun)
  {
    pattern: /\bcurl\b.*\|\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
    reason: "piping a remote download (curl) into a shell/interpreter is on the blocked list",
  },
  {
    pattern: /\bwget\b.*\|\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
    reason: "piping a remote download (wget) into a shell/interpreter is on the blocked list",
  },
  {
    pattern: /\bcurl\b\s+(?:-s\s+)?https?:\/\/.*\s*\|\s*\S/, // any pipe after curl URL
    reason: "piping a curl download into another command is on the blocked list",
  },
  {
    pattern: /\bwget\b\s+(?:-q?O-?\s+)?https?:\/\/.*\s*\|\s*\S/, // wget -O- URL | ...
    reason: "piping a wget download into another command is on the blocked list",
  },

  // In-process code execution via interpreters
  {
    pattern: /\b(?:python\d?|ruby|perl|node|deno|bun)\s+-[ce]\b/, // -c / -e flags
    reason:
      "running inline code via an interpreter flag (-c/-e) is on the blocked list; write the code to a temp file and run that instead",
  },
  {
    pattern: /\b(?:bash|sh|zsh|fish|ksh|dash)\s+-c\b/,
    reason:
      "running inline code via a shell -c flag is on the blocked list; write the code to a temp file and run that instead",
  },
  { pattern: /\beval\s+/, reason: "`eval` is on the blocked list" },

  // Process manipulation
  {
    pattern: /\bkill\s+(?:-9|-KILL|-SIGKILL)\b/,
    reason: "`kill -9`/SIGKILL is on the blocked list",
  },
  { pattern: /\bpkill\b/, reason: "`pkill` is on the blocked list" },
  { pattern: /\bkillall\b/, reason: "`killall` is on the blocked list" },

  // Fork-bomb shapes — match a function defined as `<name>(){<...>:|<name>&...}`
  // The classic `:(){ :|:& };:` and any single-letter-renamed variant. The
  // function name can be `:` (non-word), so we anchor on the preceding
  // boundary instead of `\b` which doesn't fire before `:`.
  {
    pattern: /(?:^|[\s;&|])\S+\s*\(\s*\)\s*\{[^}]*\|\s*\S+\s*&[^}]*\}\s*;\s*\S+/,
    reason: "a fork-bomb shape is on the blocked list",
  },
  {
    pattern: /\bwhile\s+(?:true|:)(?:\s|;|$)/, // while true / while :
    reason: "`while true`/`while :` infinite loop is on the blocked list",
  },

  // Permission widening
  {
    pattern: /\bchmod\s+(?:0?777|a\+rwx|a=rwx|ugo\+rwx)\b/,
    reason: "`chmod 777`/a+rwx (world-writable) is on the blocked list",
  },
  {
    pattern: /\bchmod\s+[ugoa]*[+=][rwxst]*s/, // setuid / setgid via symbolic mode
    reason: "`chmod` setting setuid/setgid (symbolic mode) is on the blocked list",
  },
  {
    pattern: /\bchmod\s+[246][0-7]{3}\b/, // setuid (4xxx) / setgid (2xxx) via numeric mode
    reason: "`chmod` setting setuid/setgid (numeric mode) is on the blocked list",
  },
  { pattern: /\bchown\s+(?:root|0)\b/, reason: "`chown root` is on the blocked list" },

  // Filesystem mounting
  { pattern: /\bmount\s+/, reason: "`mount` is on the blocked list" },
  { pattern: /\bumount\s+/, reason: "`umount` is on the blocked list" },

  // Firewall / network surface manipulation
  { pattern: /\biptables\b/, reason: "firewall manipulation (iptables) is on the blocked list" },
  { pattern: /\bnftables\b/, reason: "firewall manipulation (nftables) is on the blocked list" },
  { pattern: /\bufw\s+/, reason: "firewall manipulation (ufw) is on the blocked list" },

  // Sensitive file disclosure — common readers targeting /etc/passwd, /etc/shadow, /etc/sudoers.
  {
    pattern:
      /\b(?:cat|tac|less|more|head|tail|awk|grep|strings|od|xxd|nl|cut|sed)\s+[^|;&]*\/etc\/(?:passwd|shadow|sudoers)\b/,
    reason: "reading sensitive system files (/etc/passwd|shadow|sudoers) is on the blocked list",
  },

  // Crypto-key disclosure — readers targeting private-key paths.
  {
    pattern:
      /\b(?:cat|tac|less|more|head|tail|awk|grep|strings|od|xxd|nl)\s+[^|;&]*(?:\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys|known_hosts)|\.aws\/credentials|\.gnupg\/private-keys-v1\.d)\b/,
    reason: "reading private keys/credentials is on the blocked list",
  },

  // Sensitive file copying / exfiltration
  {
    pattern: /\bcp\b[^|;&]*\/etc\/(?:passwd|shadow|sudoers)\b/,
    reason: "copying sensitive system files (/etc/passwd|shadow|sudoers) is on the blocked list",
  },
  {
    pattern:
      /\b(?:scp|rsync)\b[^|;&]*(?:\/etc\/(?:passwd|shadow|sudoers)|\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys)|\.aws\/credentials)\b/,
    reason: "copying/exfiltrating sensitive files (scp/rsync) is on the blocked list",
  },

  // Writing backdoors into SSH authorized_keys
  {
    pattern: /\b(?:echo|printf)\b[^|;&]*>>?\s*~\/\.ssh\/authorized_keys/,
    reason: "writing to ~/.ssh/authorized_keys is on the blocked list",
  },
  {
    pattern: /\btee\b[^|;&]*~\/\.ssh\/authorized_keys/, // tee uses -a flag, not >>
    reason: "writing to ~/.ssh/authorized_keys (tee) is on the blocked list",
  },

  // rm safety bypass
  {
    pattern: /\brm\b.*--no-preserve-root/,
    reason: "`rm --no-preserve-root` is on the blocked list",
  },

  // Secure file wiping (unrecoverable)
  { pattern: /\bshred\b/, reason: "`shred` (unrecoverable wipe) is on the blocked list" },
  { pattern: /\btruncate\b/, reason: "`truncate` is on the blocked list" },
  { pattern: /\bwipefs\b/, reason: "`wipefs` (disk erase) is on the blocked list" },
  { pattern: /\bblkdiscard\b/, reason: "`blkdiscard` (disk erase) is on the blocked list" },
  {
    pattern: /\bhdparm\b.*--security-erase\b/,
    reason: "`hdparm --security-erase` (disk erase) is on the blocked list",
  },

  // Reverse shells via netcat / socat
  { pattern: /\bnc(?:at)?\b.*-[ec]\b/i, reason: "reverse shell via netcat is on the blocked list" },
  { pattern: /\bsocat\b.*\bEXEC:/i, reason: "reverse shell via socat is on the blocked list" },

  // Remote fetch then execute (two-step, without pipe — the pipe form is above)
  {
    pattern: /\bcurl\b.*&&\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
    reason: "download-then-execute (curl && shell) is on the blocked list",
  },
  {
    pattern: /\bwget\b.*&&\s*(?:sh|bash|zsh|fish|python\d?)\b/i,
    reason: "download-then-execute (wget && shell) is on the blocked list",
  },

  // Crontab manipulation (persistence / destruction)
  { pattern: /\bcrontab\s+-[er]\b/, reason: "crontab modification (-e/-r) is on the blocked list" },

  // Shell history wiping (cover-your-tracks)
  { pattern: /\bhistory\s+-[cwda]\b/, reason: "shell-history wiping is on the blocked list" },

  // User account management — backdoor creation or account destruction
  {
    pattern: /\b(?:useradd|userdel|usermod|groupadd|groupdel|groupmod)\b/,
    reason: "user/group account management is on the blocked list",
  },

  // Password changes on other accounts
  { pattern: /\bpasswd\s+\S/, reason: "`passwd` on an account is on the blocked list" },

  // sudoers editor
  { pattern: /\bvisudo\b/, reason: "`visudo` is on the blocked list" },
];

/**
 * Find the first denylist rule a command trips, or null if none. A matched rule
 * is skipped when any of its {@link ForbiddenRule.exemptions} applies to the
 * command (e.g. an `rm` whose only targets are mktemp/$TMPDIR temp paths).
 *
 * Exposed for testing and reuse. Callers must still treat the result as
 * advisory — see the doc on FORBIDDEN_COMMANDS about the limits of denylists.
 */
export function matchForbiddenCommand(command: string): ForbiddenRule | null {
  for (const rule of FORBIDDEN_COMMANDS) {
    if (!rule.pattern.test(command)) continue;
    if (rule.exemptions?.some((exemption) => exemption.matches(command))) continue;
    return rule;
  }
  return null;
}

/**
 * Pure check: does this command match any forbidden pattern?
 */
export function isDangerousCommand(command: string): boolean {
  return matchForbiddenCommand(command) !== null;
}

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

type ExecuteCommandArgs = z.infer<typeof executeCommandParameters>;

type ShellCommandDeps = FileSystem.FileSystem | FileSystemContextService | LoggerService;

/**
 * Per-stream cap for `execute_command` stdout and stderr. Alias of the shared
 * spawn cap so tests and docs can name the tool-specific bound.
 */
export const EXECUTE_COMMAND_OUTPUT_CAP_BYTES = DEFAULT_SPAWN_OUTPUT_CAP_BYTES;

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
    description:
      "Execute a shell command. Use only when no dedicated tool exists. Captured stdout and stderr are each capped at 256 KB; truncated output includes a marker so you can re-run with head/tail/grep.",
    tags: ["shell", "execution"],
    timeoutMs: 15 * 60 * 1000, // 15 minutes — executor cap so long-running commands can complete
    parameters: executeCommandParameters,
    validate: makeZodValidator(executeCommandParameters),

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
          };
        }

        const forbidden = matchForbiddenCommand(command);
        if (forbidden) {
          return {
            success: false,
            result: null,
            error: `Command blocked by the built-in safety denylist: ${forbidden.reason}. This is a specific pattern match on this command — not a general restriction on running shell commands (other commands still run normally), and tool approval does not override it. If this command is genuinely safe and necessary, ask the user to run it manually.`,
          };
        }

        try {
          // Sanitize environment variables for security, exempting any
          // agent-configured allowlist from the sensitive-name scrub.
          const envAllowlist = context.parentAgent?.config.envAllowlist ?? [];
          const sanitizedEnv = createSanitizedEnv({}, envAllowlist);

          const result = yield* Effect.promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>(
            () =>
              new Promise((resolve, reject) => {
                let resolved = false;

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

                const snapshot = bindCappedStdio(
                  child.stdout,
                  child.stderr,
                  EXECUTE_COMMAND_OUTPUT_CAP_BYTES,
                );

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
                    const collected = snapshot();
                    resolve({
                      stdout: formatCappedStream(
                        collected.stdout,
                        "stdout",
                        EXECUTE_COMMAND_OUTPUT_CAP_BYTES,
                      ),
                      stderr: formatCappedStream(
                        collected.stderr,
                        "stderr",
                        EXECUTE_COMMAND_OUTPUT_CAP_BYTES,
                      ),
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
            };
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
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: null,
            error: `Command execution failed: ${errorMessage}`,
          };
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
