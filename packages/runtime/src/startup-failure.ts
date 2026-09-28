/**
 * Reporting a command that could not start because the application layer
 * failed to build: a `--config` path that does not exist, or a config file
 * that is not valid.
 *
 * The usual error handler needs the presentation service, which lives in the
 * layer that just failed, so these go straight to stderr in the same format.
 * Use `reportStartupFailure` as the last step of the command's effect.
 */

import { formatError } from "@jazz/core/presentation/error-handler";
import type { JazzError } from "@jazz/core/types/errors";
import { toError } from "@jazz/core/utils/errors";
import { Effect } from "effect";

function isJazzError(error: unknown): error is JazzError {
  return typeof error === "object" && error !== null && "_tag" in error;
}

/** Print why startup failed on stderr and make the process exit 1. */
export function reportStartupFailure(error: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    const report = isJazzError(error) ? formatError(error) : `❌ ${toError(error).message}\n`;
    process.stderr.write(report);
    process.exitCode = 1;
  });
}
