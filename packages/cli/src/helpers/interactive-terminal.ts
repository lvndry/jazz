/**
 * Guard for commands that only work with a person at a terminal (wizards,
 * pickers, editors). Without one, every prompt would resolve `undefined`, and a
 * wizard that loops back to its first step on a cancelled answer would spin.
 * The guard refuses up front with an `InteractiveTerminalRequiredError`, which
 * the CLI prints with its suggestion and turns into exit code 2.
 *
 * ```ts
 * yield* requireInteractiveTerminal("jazz agent create", "Run it in a terminal, or ...");
 * ```
 */

import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { InteractiveTerminalRequiredError } from "@jazz/core/types/errors";
import { Effect } from "effect";

/**
 * Fail with `InteractiveTerminalRequiredError` unless the terminal can prompt.
 *
 * @param command - The command as typed, e.g. `"jazz agent create"`.
 * @param suggestion - What to do instead: where to run it, or the file to write by hand.
 */
export function requireInteractiveTerminal(
  command: string,
  suggestion: string,
): Effect.Effect<void, InteractiveTerminalRequiredError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (!terminal.isInteractive) {
      const onTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
      return yield* Effect.fail(
        new InteractiveTerminalRequiredError({
          command,
          message: onTerminal
            ? "it asks questions, which plain output (--no-tui, --output raw or quiet) cannot show."
            : "it asks questions, and stdin or stdout is not a terminal that can answer them.",
          suggestion: onTerminal ? `Run it again without those flags. ${suggestion}` : suggestion,
        }),
      );
    }
  });
}
