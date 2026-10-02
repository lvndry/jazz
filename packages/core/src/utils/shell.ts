import { spawn } from "node:child_process";
import { Effect } from "effect";
import { terminateProcessGroup } from "@/core/utils/process";
import { parseShellCommandLine, type ShellWord } from "@/core/utils/shell-syntax";

/**
 * The "always approve" key for a shell command, or `undefined` when the
 * command is not one plain command and so cannot be allowlisted.
 *
 * The key is the binary plus, when the word right after it is not a flag, that
 * word as a subcommand: `git diff --stat` keys to `git diff`, `ls -la` to `ls`,
 * `git -C repo status` to `git`. Approving `git diff` once covers every
 * `git diff ...` invocation, and the key shown to the person is exactly the
 * scope they grant.
 *
 * The command is lexed the way the shell will read it
 * (`parseShellCommandLine`). A command with control operators (`&&`, `||`,
 * `;`, `|`, `&`), command or process substitution, parameter expansion,
 * redirection, a comment, or a leading `NAME=value` assignment has no key,
 * so no allowlist entry can ever authorize it. Wrappers such as `sudo`,
 * `env` and `npx` are part of the key (`sudo apt install x` keys to
 * `sudo apt`), so allowlisting a command never extends to running it under
 * another user or environment.
 */
export function extractCommandApprovalKey(command: string): string | undefined {
  const line = parseShellCommandLine(command);
  if (line.hazards.size > 0 || line.commands.length !== 1) {
    return undefined;
  }
  const simpleCommand = line.commands[0];
  const binary = simpleCommand?.words[0];
  if (binary === undefined || !isKeyWord(binary)) {
    return undefined;
  }
  const subcommand = simpleCommand?.words[1];
  if (subcommand === undefined || subcommand.text.startsWith("-") || !isKeyWord(subcommand)) {
    return binary.text;
  }
  return `${binary.text} ${subcommand.text}`;
}

/**
 * Whether an `autoApprovedCommands` entry covers this command. An entry
 * matches its own key and any longer key that starts with it at a word
 * boundary, so `git` covers `git status` and `git status` covers
 * `git status --short`. A command without a key matches nothing.
 */
export function isCommandCoveredByAllowlist(
  command: string,
  allowedCommands: readonly string[],
): boolean {
  const commandKey = extractCommandApprovalKey(command);
  if (commandKey === undefined) {
    return false;
  }
  return allowedCommands.some(
    (allowed) => commandKey === allowed || commandKey.startsWith(`${allowed} `),
  );
}

const WHITESPACE_PATTERN = /\s/;

/** A word can be part of a key only when it is a literal the key can spell unambiguously. */
function isKeyWord(word: ShellWord): boolean {
  return word.text.length > 0 && !word.expands && !WHITESPACE_PATTERN.test(word.text);
}

/**
 * Options for executing a shell command.
 */
export interface ExecCommandOptions {
  /** Working directory for the command */
  readonly cwd?: string;
  /** Environment variables */
  readonly env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds */
  readonly timeout?: number;
}

/**
 * Execute a shell command and return the stdout output.
 * Uses spawn with shell: false for security (no shell injection).
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param options - Optional execution options
 * @returns An Effect containing stdout. A non-zero exit fails with an Error
 * whose message includes stderr, or stdout when stderr is empty; callers must
 * treat that message as potentially sensitive.
 */
export function execCommand(
  command: string,
  args: readonly string[],
  options?: ExecCommandOptions,
): Effect.Effect<string, Error> {
  return Effect.async<string, Error>((resume) => {
    const child = spawn(command, args as string[], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.env && { env: options.env }),
      ...(options?.timeout && { timeout: options.timeout }),
    });

    let stdout = "";
    let stderr = "";

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

    child.on("close", (code) => {
      if (code === 0) {
        resume(Effect.succeed(stdout));
      } else {
        resume(Effect.fail(new Error(`Command failed (exit ${code}): ${stderr || stdout}`)));
      }
    });

    child.on("error", (err) => {
      resume(Effect.fail(err));
    });

    return Effect.promise(() => terminateProcessGroup(child));
  });
}

/**
 * Execute a shell command and write to its stdin.
 * Useful for commands that expect input via stdin (e.g., crontab -).
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param stdin - Content to write to stdin
 * @param options - Optional execution options
 * @returns Effect that resolves on success, or fails with Error
 */
export function execCommandWithStdin(
  command: string,
  args: readonly string[],
  stdin: string,
  options?: ExecCommandOptions,
): Effect.Effect<void, Error> {
  return Effect.async<void, Error>((resume) => {
    const child = spawn(command, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.env && { env: options.env }),
      ...(options?.timeout && { timeout: options.timeout }),
    });

    let stderr = "";

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resume(Effect.succeed(undefined));
      } else {
        resume(Effect.fail(new Error(`Command failed (exit ${code}): ${stderr}`)));
      }
    });

    child.on("error", (err) => {
      resume(Effect.fail(err));
    });

    // The command may exit before reading stdin; the resulting EPIPE is the
    // exit code, reported by "close", so the stdin stream stays silent.
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.write(stdin);
      child.stdin.end();
    }

    return Effect.promise(() => terminateProcessGroup(child));
  });
}

/** Both output streams of a completed command, regardless of exit code. */
export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Execute a shell command, writing to its stdin, and return both stdout and stderr
 * regardless of exit code.
 *
 * `execCommandWithStdin` only ever surfaces stderr on failure — but `at` prints the job id
 * ("job 3 at ...") to stderr on a *successful* run, so callers that need that output on the
 * success path need this instead.
 */
export function execCommandWithStdinCapturingOutput(
  command: string,
  args: readonly string[],
  stdin: string,
  options?: ExecCommandOptions,
): Effect.Effect<CommandOutput, Error> {
  return Effect.async<CommandOutput, Error>((resume) => {
    const child = spawn(command, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.env && { env: options.env }),
      ...(options?.timeout && { timeout: options.timeout }),
    });

    let stdout = "";
    let stderr = "";

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

    child.on("close", (code) => {
      resume(Effect.succeed({ exitCode: code ?? -1, stdout, stderr }));
    });

    child.on("error", (err) => {
      resume(Effect.fail(err));
    });

    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.write(stdin);
      child.stdin.end();
    }

    return Effect.promise(() => terminateProcessGroup(child));
  });
}
