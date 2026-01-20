import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer, Option, Ref } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { jsonBigIntReplacer } from "@/core/utils/logging-helpers";
import { isInstalledGlobally } from "@/core/utils/runtime-detection";

/**
 * Log Write Queue
 *
 * Ensures sequential log writes to prevent interleaving while maintaining
 * fire-and-forget semantics. Each log entry is queued and written in order.
 */
class LogWriteQueue {
  private writePromise: Promise<void> = Promise.resolve();
  private dirCreated: Set<string> = new Set();

  /**
   * Enqueue a log write. Returns immediately (fire-and-forget).
   * Writes are processed sequentially in the background.
   */
  enqueue(filePath: string, content: string): void {
    // Chain this write after the previous one completes
    this.writePromise = this.writePromise
      .then(async () => {
        // Ensure directory exists (cached to avoid repeated checks)
        const dir = path.dirname(filePath);
        if (!this.dirCreated.has(dir)) {
          await mkdir(dir, { recursive: true });
          this.dirCreated.add(dir);
        }
        await appendFile(filePath, content, { encoding: "utf8" });
      })
      .catch((error) => {
        // Log errors to stderr but don't throw - logging should not break the app
        console.error(
          `[LogWriteQueue] Failed to write log: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * Wait for all pending writes to complete.
   * Useful for graceful shutdown.
   */
  async flush(): Promise<void> {
    await this.writePromise;
  }
}

// Singleton queue for all log writes
const logQueue = new LogWriteQueue();

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
  ): Effect.Effect<void, never> {
    const sessionIdRef = this.sessionIdRef;
    return Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      // Write operations are now synchronous (queued internally)
      if (Option.isSome(sessionId)) {
        writeFormattedLogToSessionFile(level, sessionId.value, message, meta);
      } else {
        writeFormattedLogToFile(level, message, meta);
      }
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
        // Write is now synchronous (queued internally)
        writeToolCallToSessionFile(sessionId.value, toolName, args);
      }
    });
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

/**
 * Flush all pending log writes
 *
 * Call this during graceful shutdown to ensure all queued log entries
 * are written to disk before the process exits.
 */
export async function flushLogs(): Promise<void> {
  await logQueue.flush();
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
 * Uses the write queue to ensure sequential writes without interleaving.
 */
function writeFormattedLogToFile(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const logsDir = getLogsDirectory();
  const logFilePath = path.join(logsDir, "jazz.log");
  const line = formatLogLineForFile(level, message, meta);
  logQueue.enqueue(logFilePath, line);
}

/**
 * Write a formatted log line to a session-specific file
 * Creates a separate log file per session ID: {sessionId}.log
 * Uses the write queue to ensure sequential writes without interleaving.
 */
function writeFormattedLogToSessionFile(
  level: "debug" | "info" | "warn" | "error",
  sessionId: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const logsDir = getLogsDirectory();
  // Sanitize sessionId for use in filename (remove invalid characters)
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);
  const line = formatLogLineForFile(level, message, meta);
  logQueue.enqueue(logFilePath, line);
}

/**
 * Write a tool call to the session log file in the same format as chat messages
 * Format: [timestamp] [TOOL_CALL] toolName {args}
 * Uses the write queue to ensure sequential writes without interleaving.
 */
function writeToolCallToSessionFile(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const logsDir = getLogsDirectory();
  // Sanitize sessionId for use in filename (remove invalid characters)
  const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);
  const timestamp = new Date().toISOString();

  // Format arguments as JSON
  const argsJson = JSON.stringify(args);
  const content = `${toolName} ${argsJson}`;
  const line = `[${timestamp}] [TOOL_CALL] ${content}\n`;

  logQueue.enqueue(logFilePath, line);
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
