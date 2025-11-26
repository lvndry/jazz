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

/**
 * JSON writer - accumulates structured output for programmatic consumption
 */
export class JSONWriter implements OutputWriter {
  private events: Array<{ type: string; content: string; timestamp: number }> = [];

  write(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.events.push({
        type: "text",
        content: text,
        timestamp: Date.now(),
      });
    });
  }

  writeLine(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.events.push({
        type: "line",
        content: text,
        timestamp: Date.now(),
      });
    });
  }

  clearLines(_count: number): Effect.Effect<void, never> {
    // No-op for JSON writer - we don't modify previous output
    return Effect.void;
  }

  flush(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      // Output accumulated JSON to stdout
      console.log(JSON.stringify(this.events, null, 2));
      this.events = [];
    });
  }

  /**
   * Get accumulated events without flushing
   */
  getEvents(): ReadonlyArray<{ type: string; content: string; timestamp: number }> {
    return this.events;
  }
}

/**
 * Test writer - captures output for testing
 */
export class TestWriter implements OutputWriter {
  private buffer: string[] = [];

  write(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.buffer.push(text);
    });
  }

  writeLine(text: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.buffer.push(text + "\n");
    });
  }

  clearLines(_count: number): Effect.Effect<void, never> {
    // For testing, we just record that clear was called
    return Effect.void;
  }

  flush(): Effect.Effect<void, never> {
    return Effect.void;
  }

  /**
   * Get all captured output as a single string
   */
  getOutput(): string {
    return this.buffer.join("");
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = [];
  }
}

/**
 * Quiet writer - suppresses all output except errors
 */
export class QuietWriter implements OutputWriter {
  write(_text: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  writeLine(_text: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  clearLines(_count: number): Effect.Effect<void, never> {
    return Effect.void;
  }

  flush(): Effect.Effect<void, never> {
    return Effect.void;
  }
}
