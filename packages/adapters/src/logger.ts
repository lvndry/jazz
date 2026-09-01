/**
 * Implements `LoggerService`: writes to a per-run log file on disk, serialized through a
 * single write queue so concurrent log calls never interleave mid-line.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { jsonBigIntReplacer } from "@jazz/core/agent/tools/tool-logging";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import type { LoggingConfig } from "@jazz/core/types/config";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect, Layer, Option, Ref } from "effect";

let globalLogFormat: LoggingConfig["format"] = "plain";
let globalLogLevel: "debug" | "info" | "warn" | "error" = "info";

/**
 * Log level priority for filtering
 * Higher number = higher priority
 */
const LOG_LEVEL_PRIORITY: Record<"debug" | "info" | "warn" | "error", number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Metadata keys whose values are credentials and must never be persisted in a log.
 *
 * Tool arguments and structured metadata commonly carry HTTP headers or provider
 * credentials. Match keys at every depth so a nested `headers.authorization` is
 * protected just as a top-level `apiKey` is.
 */
const SENSITIVE_LOG_KEY_PATTERN =
  /authorization|api[-_]?key|token|secret|password|credential|cookie|passphrase/i;

/**
 * Return a deep, non-mutating copy of log metadata with credential-bearing fields
 * replaced. The logger is the final persistence boundary, so every structured log
 * format must pass through this function before serialization.
 */
export function redactLogMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactLogValue(metadata, new WeakMap<object, unknown>()) as Record<string, unknown>;
}

function redactLogValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    for (const item of value) {
      redacted.push(redactLogValue(item, seen));
    }
    return redacted;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const redacted: Record<string, unknown> = {};
  seen.set(value, redacted);
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_LOG_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactLogValue(nestedValue, seen);
  }
  return redacted;
}

/**
 * Check if a log at the given level should be written based on the configured level
 */
function shouldLog(level: "debug" | "info" | "warn" | "error"): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[globalLogLevel];
}

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
 * Provides a custom logger implementation that maintains plain formatting
 */

export class LoggerServiceImpl implements LoggerService {
  private readonly logScopeRef: Ref.Ref<Option.Option<string>>;

  constructor(conversationId?: string) {
    this.logScopeRef = Ref.unsafeMake(conversationId ? Option.some(conversationId) : Option.none());
  }

  /**
   * Set the session ID for this logger instance
   * All subsequent logs will be written to the session-specific file
   */
  setLogGroup(conversationId: string): Effect.Effect<void, never> {
    return Ref.set(this.logScopeRef, Option.some(conversationId));
  }

  /**
   * Clear the session ID
   * Subsequent logs will be written to the general log file
   */
  clearLogGroup(): Effect.Effect<void, never> {
    return Ref.set(this.logScopeRef, Option.none());
  }

  writeToFile(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, never> {
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      // Write operations are now synchronous (queued internally)
      if (Option.isSome(conversationId)) {
        writeFormattedLogToSessionFile(level, conversationId.value, message, meta);
      } else {
        writeFormattedLogToFile(level, message, meta);
      }
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    if (!shouldLog("debug")) return Effect.void;
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToSessionFile("debug", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("debug", message, meta);
        }
      });
    });
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    if (!shouldLog("info")) return Effect.void;
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToSessionFile("info", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("info", message, meta);
        }
      });
    });
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    if (!shouldLog("warn")) return Effect.void;
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToSessionFile("warn", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("warn", message, meta);
        }
      });
    });
  }

  error(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    if (!shouldLog("error")) return Effect.void;
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToSessionFile("error", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("error", message, meta);
        }
      });
    });
  }

  logToolCall(toolName: string, args: Record<string, unknown>): Effect.Effect<void, never> {
    const logScopeRef = this.logScopeRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(logScopeRef);
      if (Option.isSome(conversationId)) {
        // Write is now synchronous (queued internally)
        writeToolCallToSessionFile(conversationId.value, toolName, args);
      }
    });
  }
}

/**
 * Create the logger layer
 *
 * Creates a single logger instance that can dynamically scope logs to sessions
 * using setLogGroup() and clearLogGroup() methods.
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
  conversationId?: string,
): string {
  if (globalLogFormat === "json") {
    return formatLogLineAsJson(level, message, meta, conversationId);
  }
  return formatLogLineAsPlain(level, message, meta);
}

/**
 * Format log line as JSON (NDJSON - one JSON object per line)
 * Compatible with jq and log processors like Datadog, Splunk
 */
export function formatLogLineAsJson(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
  conversationId?: string,
): string {
  const logEntry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
  };

  if (conversationId) {
    logEntry["conversationId"] = conversationId;
  }

  if (meta && Object.keys(meta).length > 0) {
    // Spread meta fields at top level for easier querying
    Object.assign(logEntry, redactLogMetadata(meta));
  }

  return JSON.stringify(logEntry, jsonBigIntReplacer) + "\n";
}

/**
 * Format log line as human-readable plain format
 */
export function formatLogLineAsPlain(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): string {
  const now = new Date();
  const metaText =
    meta && Object.keys(meta).length > 0
      ? " " + JSON.stringify(redactLogMetadata(meta), jsonBigIntReplacer)
      : "";
  return `${now.toLocaleDateString()} ${now.toLocaleTimeString()} [${level.toUpperCase()}] ${message}${metaText}\n`;
}

const LOG_FORMATS: readonly LoggingConfig["format"][] = ["json", "plain"];

/**
 * Coerce a persisted log format to one this build supports.
 *
 * The config file is not schema-validated, so a value written by an older
 * build (such as the removed `toon`) still reaches us typed but unsupported.
 * Mapping it here keeps the fallback deliberate instead of an unnoticed
 * fall-through in the formatter.
 */
export function normalizeLogFormat(format: string | undefined): LoggingConfig["format"] {
  return LOG_FORMATS.includes(format as LoggingConfig["format"])
    ? (format as LoggingConfig["format"])
    : "plain";
}

/**
 * Set the global log format
 * Call this during app initialization based on config
 */
export function setLogFormat(format: LoggingConfig["format"]): void {
  globalLogFormat = normalizeLogFormat(format);
}

/**
 * Get the current log format
 */
export function getLogFormat(): LoggingConfig["format"] {
  return globalLogFormat;
}

/**
 * Set the global log level
 * Call this during app initialization based on config
 */
export function setLogLevel(level: "debug" | "info" | "warn" | "error"): void {
  globalLogLevel = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): "debug" | "info" | "warn" | "error" {
  return globalLogLevel;
}

/**
 * Shared helper to write a formatted log line to file
 * Writes to the general jazz.log file (used when no conversationId is set)
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
 * Creates a separate log file per session ID: {conversationId}.log
 * Uses the write queue to ensure sequential writes without interleaving.
 */
function writeFormattedLogToSessionFile(
  level: "debug" | "info" | "warn" | "error",
  conversationId: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const logsDir = getLogsDirectory();
  // Sanitize conversationId for use in filename (remove invalid characters)
  const sanitizedId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);
  const line = formatLogLineForFile(level, message, meta, conversationId);
  logQueue.enqueue(logFilePath, line);
}

/**
 * Write a tool call to the session log file in the same format as chat messages
 * Format: [timestamp] [TOOL_CALL] toolName {args}
 * Uses the write queue to ensure sequential writes without interleaving.
 */
function writeToolCallToSessionFile(
  conversationId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const logsDir = getLogsDirectory();
  // Sanitize conversationId for use in filename (remove invalid characters)
  const sanitizedId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `${sanitizedId}.log`);

  logQueue.enqueue(logFilePath, formatToolCallLogLine(conversationId, toolName, args));
}

/** Format a redacted tool call as a session log entry in the selected format. */
export function formatToolCallLogLine(
  conversationId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const redactedArgs = redactLogMetadata(args);
  if (getLogFormat() === "json") {
    return formatLogLineAsJson("info", `Tool Call: ${toolName}`, redactedArgs, conversationId);
  }

  const timestamp = new Date().toISOString();
  const argsJson = JSON.stringify(redactedArgs, jsonBigIntReplacer);
  return `[${timestamp}] [TOOL_CALL] ${toolName} ${argsJson}\n`;
}

/**
 * Resolve the logs directory path
 * 1. Check JAZZ_LOG_DIR environment variable
 * 2. Default to ~/.jazz/logs (or JAZZ_HOME/logs)
 */
function resolveLogsDirectory(): string {
  const override = process.env["JAZZ_LOG_DIR"];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  return path.join(getJazzHomeDirectory(), "logs");
}
