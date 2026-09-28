/**
 * Leaving quietly when the reader of stdout or stderr goes away.
 *
 * `jazz agent list | grep -q tiny` closes the pipe as soon as grep has its
 * match, and the next write fails with EPIPE. Classic Unix tools die of
 * SIGPIPE there without a word; Bun instead throws from `write` (or emits an
 * `error` event), which surfaced as a crash with a stack trace. Call
 * `exitQuietlyOnBrokenPipe` once at startup: a write to a closed pipe then ends
 * the process with the exit code the command had already set (0 otherwise),
 * and every other write error still propagates.
 */

/** Whether an error is a write to a pipe whose reader has closed. */
export function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function exitForBrokenPipe(): never {
  process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
}

function guard(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = (...args: unknown[]): boolean => {
    try {
      return write(...args);
    } catch (error) {
      if (isBrokenPipe(error)) {
        exitForBrokenPipe();
      }
      throw error;
    }
  };
  stream.on("error", (error) => {
    if (isBrokenPipe(error)) {
      exitForBrokenPipe();
    }
    throw error;
  });
}

/** Install the guard on stdout and stderr. */
export function exitQuietlyOnBrokenPipe(): void {
  guard(process.stdout);
  guard(process.stderr);
}
