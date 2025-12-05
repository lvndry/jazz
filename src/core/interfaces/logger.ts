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
   * Write a log entry to file
   * Automatically routes to session-specific file if sessionId is set
   */
  readonly writeToFile: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, Error>;
  /**
   * Log a tool call to the session log file (if sessionId is set)
   * Uses the same format as chat messages: [timestamp] [TOOL_CALL] toolName {args}
   */
  readonly logToolCall: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<void, never>;
  /**
   * Set the session ID for this logger instance
   * All subsequent logs will be written to the session-specific file
   */
  readonly setSessionId: (sessionId: string) => Effect.Effect<void, never>;
  /**
   * Clear the session ID
   * Subsequent logs will be written to the general log file
   */
  readonly clearSessionId: () => Effect.Effect<void, never>;
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");
