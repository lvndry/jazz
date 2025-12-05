import { Effect, Layer, Option, Ref } from "effect";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LoggerServiceTag, type LoggerService } from "../core/interfaces/logger";
import { jsonBigIntReplacer } from "../core/utils/logging-helpers";
import { isInstalledGlobally } from "../core/utils/runtime-detection";

/**
 * Provides a custom logger implementation that maintains pretty formatting
 */

export class LoggerServiceImpl implements LoggerService {
  private readonly sessionIdRef: Ref.Ref<Option.Option<string>>;

  constructor(sessionId?: string) {
    this.sessionIdRef = Ref.unsafeMake(sessionId ? Option.some(sessionId) : Option.none());
  }

  /**
   * Set the session ID for this logger instance
   * All subsequent logs will be written to the session-specific file
   */
  setSessionId(sessionId: string): Effect.Effect<void, never> {
    return Ref.set(this.sessionIdRef, Option.some(sessionId));
  }

  /**
   * Clear the session ID
   * Subsequent logs will be written to the general log file
   */
  clearSessionId(): Effect.Effect<void, never> {
    return Ref.set(this.sessionIdRef, Option.none());
  }

  writeToFile(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, Error> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      return yield* Effect.tryPromise({
        try: () => {
          if (Option.isSome(sessionId)) {
            return writeFormattedLogToSessionFile(level, sessionId.value, message, meta);
          }
          return writeFormattedLogToFile(level, message, meta);
        },
        catch: (error: unknown) =>
          new Error(
            `Failed to write to log file: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(sessionId)) {
          void writeFormattedLogToSessionFile("debug", sessionId.value, message, meta);
        } else {
          void writeFormattedLogToFile("debug", message, meta);
        }
      });
    });
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(sessionId)) {
          void writeFormattedLogToSessionFile("info", sessionId.value, message, meta);
        } else {
          void writeFormattedLogToFile("info", message, meta);
        }
      });
    });
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(sessionId)) {
          void writeFormattedLogToSessionFile("warn", sessionId.value, message, meta);
        } else {
          void writeFormattedLogToFile("warn", message, meta);
        }
      });
    });
  }

  error(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(sessionId)) {
          void writeFormattedLogToSessionFile("error", sessionId.value, message, meta);
        } else {
          void writeFormattedLogToFile("error", message, meta);
        }
      });
    });
  }

  logToolCall(toolName: string, args: Record<string, unknown>): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      if (Option.isSome(sessionId)) {
        yield* Effect.tryPromise({
          try: () => writeToolCallToSessionFile(sessionId.value, toolName, args),
          catch: () => undefined, // Silently fail - logging should not break execution
        });
      }
    }).pipe(Effect.catchAll(() => Effect.void));
  }
}

/**
 * Create the logger layer
 *
 * Creates a single logger instance that can dynamically scope logs to sessions
 * using setSessionId() and clearSessionId() methods.
 */
export function createLoggerLayer(): Layer.Layer<LoggerService, never, never> {
  return Layer.succeed(LoggerServiceTag, new LoggerServiceImpl());
}

let logsDirectoryCache: string | undefined;

/**
 * Get the logs directory path
 * Uses caching for performance
 */
export function getLogsDirectory(): string {
  if (!logsDirectoryCache) {
    logsDirectoryCache = resolveLogsDirectory();
  }

  return logsDirectoryCache;
}

/**
 * Shared helper to format a log line for file output
 */
function formatLogLineForFile(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): string {
  const now = new Date();
  const metaText =
    meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta, jsonBigIntReplacer) : "";
  return `${now.toLocaleDateString()} ${now.toLocaleTimeString()} [${level.toUpperCase()}] ${message}${metaText}\n`;
}

/**
 * Shared helper to write a formatted log line to file
 * Writes to the general jazz.log file (used when no sessionId is set)
 */
async function writeFormattedLogToFile(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const logsDir = getLogsDirectory();
  await mkdir(logsDir, { recursive: true });
  const logFilePath = path.join(logsDir, "jazz.log");
  const line = formatLogLineForFile(level, message, meta);
  await appendFile(logFilePath, line, { encoding: "utf8" });
}

/**
 * Write a formatted log line to a session-specific file
 * Creates a separate log file per session ID: {sessionId}.log
 */
async function writeFormattedLogToSessionFile(
  level: "debug" | "info" | "warn" | "error",
  sessionId: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const logsDir = getLogsDirectory();
  await mkdir(logsDir, { recursive: true });
  // Sanitize sessionId for use in filename (remove invalid characters)
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);
  const line = formatLogLineForFile(level, message, meta);
  await appendFile(logFilePath, line, { encoding: "utf8" });
}

/**
 * Write a tool call to the session log file in the same format as chat messages
 * Format: [timestamp] [TOOL_CALL] toolName {args}
 */
async function writeToolCallToSessionFile(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const logsDir = getLogsDirectory();
  await mkdir(logsDir, { recursive: true });
  // Sanitize sessionId for use in filename (remove invalid characters)
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);
  const timestamp = new Date().toISOString();

  // Format arguments as JSON
  const argsJson = JSON.stringify(args);
  const content = `${toolName} ${argsJson}`;
  const line = `[${timestamp}] [TOOL_CALL] ${content}\n`;

  await appendFile(logFilePath, line, { encoding: "utf8" });
}

/**
 * Resolve the logs directory path
 * 1. Check JAZZ_LOG_DIR environment variable
 * 2. Check if installed globally (~/.jazz/logs)
 * 3. Default to cwd/logs
 */
function resolveLogsDirectory(): string {
  // 1. Allow manual override via environment variable
  const override = process.env["JAZZ_LOG_DIR"];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  // 2. Check if we're in a globally installed package
  if (isInstalledGlobally()) {
    // Global install: use ~/.jazz/logs
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return path.join(homeDir, ".jazz", "logs");
    }
  }

  // 3. Local development or local install: use cwd/logs
  return path.resolve(process.cwd(), "logs");
}
