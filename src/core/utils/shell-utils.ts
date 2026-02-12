import { spawn } from "node:child_process";
import { Effect } from "effect";

/**
 * Extract a subcommand-level approval key from a shell command string.
 *
 * Instead of storing the full command (e.g. "git diff --name-only") as the
 * approval key, we extract the binary + first non-flag subcommand token
 * (e.g. "git diff"). This way, approving "git diff" once covers all flag
 * variants like "git diff --stat", "git diff --name-only HEAD~3", etc.
 *
 * For commands without subcommands (e.g. "ls -la"), only the binary name
 * is returned ("ls"). Environment variable prefixes (FOO=bar) and common
 * command prefixes (sudo, env, npx, etc.) are skipped.
 *
 * Since matching uses `startsWith`, the returned key acts as a prefix:
 * approving "git diff" auto-approves any command starting with "git diff".
 */
export function extractCommandApprovalKey(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  // Tokenize respecting simple quoting (we only need the first few tokens)
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) return trimmed;

  // Skip env-var prefixes like FOO=bar and wrapper commands like sudo/env/npx
  const WRAPPER_COMMANDS = new Set(["sudo", "env", "npx", "bunx", "pnpx", "nohup", "nice", "time"]);
  let startIdx = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // Skip env-var assignments (KEY=value)
    if (tok.includes("=") && !tok.startsWith("-")) {
      startIdx = i + 1;
      continue;
    }
    // Skip wrapper/prefix commands
    if (WRAPPER_COMMANDS.has(tok)) {
      startIdx = i + 1;
      continue;
    }
    break;
  }

  if (startIdx >= tokens.length) return trimmed;

  const binary = tokens[startIdx]!;

  // Look for the first non-flag argument after the binary (the subcommand)
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Skip flags (--foo, -f)
    if (token.startsWith("-")) continue;
    // Found a subcommand-like token
    return `${binary} ${token}`;
  }

  // No subcommand found — just the binary
  return binary;
}

/**
 * Minimal tokenizer that splits a command string into tokens,
 * respecting single and double quotes. Only needed for the first
 * few tokens so it doesn't need to be exhaustive.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
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
 * @returns Effect that resolves with stdout on success, or fails with Error
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

    // Write content to stdin
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
