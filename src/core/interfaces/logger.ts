import { Context, Effect } from "effect";

export interface LoggerService {
  /** Logs a debug message with optional metadata. */
  readonly debug: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  /** Logs an info message with optional metadata. */
  readonly info: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  /** Logs a warning message with optional metadata. */
  readonly warn: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  /** Logs an error message with optional metadata. */
  readonly error: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  /**
   * Write a log entry to file only (not console)
   * Used for detailed logging that should not clutter console output
   */
  readonly writeToFile: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, Error>;
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");
