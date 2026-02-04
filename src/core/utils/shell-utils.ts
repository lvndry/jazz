import { spawn } from "node:child_process";
import { Effect } from "effect";

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
