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
   * Automatically routes to conversation-specific file if conversationId is set
   */
  readonly writeToFile: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, Error>;
  /**
   * Set the conversation ID for this logger instance
   * All subsequent logs will be written to the conversation-specific file
   */
  readonly setConversationId: (conversationId: string) => Effect.Effect<void, never>;
  /**
   * Clear the conversation ID
   * Subsequent logs will be written to the general log file
   */
  readonly clearConversationId: () => Effect.Effect<void, never>;
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");
