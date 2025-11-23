import { Context, Effect, Layer } from "effect";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInstalledGlobally } from "../core/utils/runtime-detection";
import { formatToolArguments } from "../core/utils/tool-formatter";
import { type ConfigService } from "./config";

/**
 * Structured logging service using Effect's Logger API
 *
 * Provides a custom logger implementation that maintains pretty formatting
 * (colors, emojis) while leveraging Effect's built-in logging capabilities
 * including automatic context propagation, fiber IDs, and log level management.
 */

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

export class LoggerServiceImpl implements LoggerService {
  constructor() {}

  writeToFile(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => writeFormattedLogToFile(level, message, meta),
      catch: (error: unknown) =>
        new Error(
          `Failed to write to log file: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  }

  debug(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      void writeLogToFile("debug", message, meta);
    });
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      void writeLogToFile("info", message, meta);
    });
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      void writeLogToFile("warn", message, meta);
    });
  }

  error(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    return Effect.sync(() => {
      void writeLogToFile("error", message, meta);
    });
  }
}

/**
 * Custom replacer for JSON.stringify to handle BigInt values
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");

/**
 * Create the logger layer
 *
 * Sets up the LoggerService for use throughout the application.
 */
export function createLoggerLayer(): Layer.Layer<LoggerService, never, never> {
  return Layer.succeed(LoggerServiceTag, new LoggerServiceImpl());
}

// Helper functions for common logging patterns
export function logAgentOperation(
  agentId: string,
  operation: string,
  meta?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info(`Agent ${agentId}: ${operation}`, {
      agentId,
      operation,
      ...meta,
    });
  });
}

// Tool execution logging helpers
export function logToolExecutionStart(
  toolName: string,
  args?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const argsText = formatToolArguments(toolName, args, { style: "plain" });
    const message = argsText ? `${toolEmoji} ${toolName} ${argsText}` : `${toolEmoji} ${toolName}`;
    yield* logger.info(message);
  });
}

export function logToolExecutionSuccess(
  toolName: string,
  durationMs: number,
  resultSummary?: string,
  fullResult?: unknown,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = resultSummary
      ? `${toolEmoji} ${toolName} ✅ (${duration}) - ${resultSummary}`
      : `${toolEmoji} ${toolName} ✅ (${duration})`;

    yield* logger.info(message);

    // Log full result to file only (not console) for ALL tools
    if (fullResult !== undefined) {
      try {
        const resultString =
          typeof fullResult === "string" ? fullResult : JSON.stringify(fullResult, null, 2);

        // Truncate very long results to avoid overwhelming logs
        const maxLength = 10000;
        const truncatedResult =
          resultString.length > maxLength
            ? resultString.substring(0, maxLength) +
              `\n... (truncated, ${resultString.length - maxLength} more characters)`
            : resultString;

        yield* logger
          .writeToFile("info", `Tool result for ${toolName}`, {
            toolName,
            resultLength: resultString.length,
            result: truncatedResult,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      } catch (error) {
        // If serialization fails, log a warning to file
        yield* logger
          .writeToFile("warn", `Failed to log full result for ${toolName}`, {
            toolName,
            error: error instanceof Error ? error.message : String(error),
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }
  });
}

export function logToolExecutionError(
  toolName: string,
  durationMs: number,
  error: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ✗ (${duration}) - ${error}`;

    yield* logger.error(message);
  });
}

export function logToolExecutionApproval(
  toolName: string,
  durationMs: number,
  approvalMessage: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ⚠️ APPROVE REQUIRED (${duration}) - ${approvalMessage}`;

    yield* logger.warn(message);
  });
}

// Utility functions for tool logging
function getToolEmoji(toolName: string): string {
  const toolEmojis: Record<string, string> = {
    // Gmail tools
    list_emails: "📧",
    get_email: "📨",
    send_email: "📤",
    reply_to_email: "↩️",
    forward_email: "↗️",
    mark_as_read: "👁️",
    mark_as_unread: "👁️‍🗨️",
    delete_email: "🗑️",
    create_label: "🏷️",
    add_label: "🏷️",
    remove_label: "🏷️",
    search_emails: "🔍",
    // Default
    default: "🔧",
  };

  const emoji = toolEmojis[toolName];
  if (emoji !== undefined) {
    return emoji;
  }
  return "🔧"; // Default emoji
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }
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
  const timestamp = new Date().toISOString();
  const metaText =
    meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta, jsonReplacer) : "";
  return `${timestamp} [${level.toUpperCase()}] ${message}${metaText}\n`;
}

/**
 * Shared helper to write a formatted log line to file
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
 * Write a log entry directly to file synchronously (standalone function)
 * Useful for Effect Logger which requires synchronous execution
 */
export function writeLogToFileSync(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    const logsDir = getLogsDirectory();
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const logFilePath = path.join(logsDir, "jazz.log");
    const line = formatLogLineForFile(level, message, meta);
    appendFileSync(logFilePath, line, { encoding: "utf8" });
  } catch {
    // Silently fail to avoid breaking the calling code
  }
}

/**
 * Write a log entry directly to file (standalone function, no Effect/dependencies)
 * Useful for logging in contexts where LoggerService is not available
 */
export async function writeLogToFile(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeFormattedLogToFile(level, message, meta);
  } catch {
    // Silently fail to avoid breaking the calling code
  }
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
