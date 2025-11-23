import { Effect } from "effect";

export interface LoggerService {
  readonly debug: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  readonly info: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
  readonly warn: (message: string, meta?: Record<string, unknown>) => Effect.Effect<void, never>;
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
