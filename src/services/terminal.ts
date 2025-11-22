import chalk from "chalk";
import { Context, Effect, Layer } from "effect";

/**
 * Terminal output service for consistent CLI styling
 *
 * Provides a unified interface for terminal output with automatic
 * emoji prefixes, color coding, and formatting.
 */

export interface TerminalService {
  /**
   * Display an informational message
   */
  readonly info: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a success message
   */
  readonly success: (message: string) => Effect.Effect<void, never>;

  /**
   * Display an error message
   */
  readonly error: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a warning message
   */
  readonly warn: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a plain message without styling
   */
  readonly log: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a debug message (only shown in debug mode)
   */
  readonly debug: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;

  /**
   * Display a section heading
   */
  readonly heading: (message: string) => Effect.Effect<void, never>;

  /**
   * Display a formatted list
   */
  readonly list: (items: string[]) => Effect.Effect<void, never>;
}

export class TerminalServiceImpl implements TerminalService {
  constructor() {}

  info(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.cyan("🔍") + " " + message);
    });
  }

  success(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.green("✅") + " " + message);
    });
  }

  error(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.red("❌") + " " + message);
    });
  }

  warn(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(chalk.yellow("⚠️") + " " + message);
    });
  }

  log(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log(message);
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (meta) {
        console.debug(message, meta);
      } else {
        console.debug(message);
      }
    });
  }

  heading(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log();
      console.log(chalk.bold.cyan(message));
      console.log();
    });
  }

  list(items: string[]): Effect.Effect<void, never> {
    return Effect.sync(() => {
      for (const item of items) {
        console.log("   • " + item);
      }
    });
  }
}

export const TerminalServiceTag = Context.GenericTag<TerminalService>("TerminalService");

/**
 * Create the terminal service layer
 */
export function createTerminalServiceLayer(): Layer.Layer<TerminalService, never, never> {
  return Layer.succeed(TerminalServiceTag, new TerminalServiceImpl());
}
