import { Effect } from "effect";

/**
 * Output writer interface - abstracts where LLM output goes
 * This enables testing, JSON output, file logging, and other LLM output targets
 */
export interface OutputWriter {
  /**
   * Write text without newline
   */
  write(text: string): Effect.Effect<void, never>;

  /**
   * Write text with newline
   */
  writeLine(text: string): Effect.Effect<void, never>;

  /**
   * Clear N lines from the terminal (for updating previous content)
   * This is a no-op for non-terminal writers (JSON, file)
   */
  clearLines(count: number): Effect.Effect<void, never>;

  /**
   * Flush any buffered output
   */
  flush(): Effect.Effect<void, never>;
}

/**
 * Terminal writer - writes to stdout/stderr
 */
export class TerminalWriter implements OutputWriter {
  write(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      process.stdout.write(text);
    });
  }

  writeLine(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(text);
    });
  }

  clearLines(count: number): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (count > 0 && process.stdout.isTTY) {
        // Move cursor up N lines and clear to end of screen
        process.stdout.write(`\x1b[${count}A\x1b[0J`);
      }
    });
  }

  flush(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // stdout is auto-flushed, but we add explicit flush for completeness
      if (process.stdout.write("")) {
        // Write succeeded, already flushed
      }
    });
  }
}
