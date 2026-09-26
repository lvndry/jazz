/**
 * @fileoverview How a command with a `--json` flag reports. With the flag, every outcome is one
 * JSON envelope on stdout, so a script parses a single line; without it, results go to stdout
 * and failures to stderr as plain text.
 */

/** Print a result: `envelope` as one JSON line with `--json`, `text` otherwise. */
export function emitEnvelope(json: boolean, envelope: Record<string, unknown>, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${text}\n`);
}

/** Report a refusal or failure and set the exit code. */
export function failEnvelope(json: boolean, error: string, exitCode = 1): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    process.stderr.write(`${error}\n`);
  }
  process.exitCode = exitCode;
}
