import { Context, Effect, Layer, Logger } from "effect";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInstalledGlobally } from "../core/utils/runtime-detection";
import { formatToolArguments } from "../core/utils/tool-formatter";
import { AgentConfigService, type ConfigService } from "./config";

/**
 * Structured logging service using Effect's Logger API
 *
 * Provides a custom logger implementation that maintains pretty formatting
 * (colors, emojis) while leveraging Effect's built-in logging capabilities
 * including automatic context propagation, fiber IDs, and log level management.
 */

export interface LoggerService {
  readonly debug: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never>;
  readonly info: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never>;
  readonly warn: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never>;
  readonly error: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never>;
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

  debug(
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, never> {
    const logEffect = Effect.logDebug(message);
    return meta && Object.keys(meta).length > 0
      ? Effect.annotateLogs(meta)(logEffect)
      : logEffect;
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const logEffect = Effect.logInfo(message);
    return meta && Object.keys(meta).length > 0
      ? Effect.annotateLogs(meta)(logEffect)
      : logEffect;
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const logEffect = Effect.logWarning(message);
    return meta && Object.keys(meta).length > 0
      ? Effect.annotateLogs(meta)(logEffect)
      : logEffect;
  }

  error(
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, never> {
    const logEffect = Effect.logError(message);
    return meta && Object.keys(meta).length > 0
      ? Effect.annotateLogs(meta)(logEffect)
      : logEffect;
  }
}

type AppLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Format a log line with pretty colors and emojis
 */
function formatLogLine(
  level: AppLogLevel,
  message: string,
  meta?: Record<string, unknown>,
  format: "json" | "pretty" = "pretty",
): string {
  const now = new Date();
  const ts = now.toISOString();
  const color = selectColor(level);
  const levelLabel = padLevel(level.toUpperCase());
  const emoji = selectEmoji(level);

  let metaText = "";
  if (meta && Object.keys(meta).length > 0) {
    if (format === "pretty") {
      metaText = dim(" " + prettyPrintJson(meta));
    } else {
      metaText = dim(" " + JSON.stringify(meta, jsonReplacer));
    }
  }

  const body = indentMultiline(message);
  return `${dim(ts)} ${color(levelLabel)} ${emoji} ${body}${metaText}`;
}

function selectColor(level: AppLogLevel): (text: string) => string {
  switch (level) {
    case "debug":
      return gray;
    case "info":
      return cyan;
    case "warn":
      return yellow;
    case "error":
      return red;
  }
}

function selectEmoji(level: AppLogLevel): string {
  switch (level) {
    case "debug":
      return "🔍";
    case "info":
      return "ℹ️";
    case "warn":
      return "⚠️";
    case "error":
      return "❌";
  }
}

function padLevel(level: string): string {
  // Ensures consistent width: DEBUG/ INFO/ WARN/ ERROR
  return level.padEnd(5, " ");
}

function indentMultiline(text: string): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  return lines.map((line, idx) => (idx === 0 ? line : "  " + line)).join("\n");
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

function prettyPrintJson(obj: Record<string, unknown>): string {
  try {
    const jsonString = JSON.stringify(obj, jsonReplacer, 2);
    // Add indentation to each line except the first
    const lines = jsonString.split("\n");
    return lines.map((line, idx) => (idx === 0 ? line : "  " + line)).join("\n");
  } catch {
    // Fallback to regular JSON.stringify if pretty printing fails
    return JSON.stringify(obj, jsonReplacer);
  }
}

// ANSI color helpers (no dependency)
function wrap(open: string, close: string): (text: string) => string {
  const enabled = process.stdout.isTTY === true;
  return (text: string) => (enabled ? `${open}${text}${close}` : text);
}

const dim = wrap("\u001B[2m", "\u001B[22m");
const gray = wrap("\u001B[90m", "\u001B[39m");
const cyan = wrap("\u001B[36m", "\u001B[39m");
const yellow = wrap("\u001B[33m", "\u001B[39m");
const red = wrap("\u001B[31m", "\u001B[39m");

/**
 * Create a custom Effect Logger that formats logs with pretty colors and emojis
 *
 * @param minLevel - Minimum log level to output (logs below this level are filtered out)
 * @param format - Output format ("pretty" or "json")
 */
function createPrettyLogger(
  minLevel: AppLogLevel,
  format: "json" | "pretty" = "pretty",
): Logger.Logger<unknown, void> {
  const minLevelOrdinal = getLogLevelOrdinal(minLevel);

  return Logger.make(({ logLevel, message, annotations }) => {
    // Filter by minimum log level
    const levelLabel = logLevel.label.toLowerCase();
    const currentLevelOrdinal = getLogLevelOrdinalFromLabel(levelLabel);
    if (currentLevelOrdinal < minLevelOrdinal) {
      return; // Skip logs below minimum level
    }

    // Extract message and metadata from annotations
    const logMessage = typeof message === "string" ? message : String(message);
    const meta: Record<string, unknown> = {};

    // Collect annotations as metadata (excluding internal Effect annotations)
    for (const [key, value] of annotations) {
      if (!key.startsWith("effect.")) {
        meta[key] = value;
      }
    }

    // Map Effect LogLevel to our AppLogLevel
    // Effect LogLevels: Trace < Debug < Info < Warning < Error < Fatal
    let appLevel: AppLogLevel;
    if (levelLabel === "debug" || levelLabel === "trace") {
      appLevel = "debug";
    } else if (levelLabel === "info") {
      appLevel = "info";
    } else if (levelLabel === "warning" || levelLabel === "warn") {
      appLevel = "warn";
    } else {
      appLevel = "error";
    }

    const formattedLine = formatLogLine(appLevel, logMessage, Object.keys(meta).length > 0 ? meta : undefined, format);

    // Output to appropriate console method
    switch (appLevel) {
      case "debug":
        console.debug(formattedLine);
        console.log();
        break;
      case "info":
        console.info(formattedLine);
        console.log();
        break;
      case "warn":
        console.warn(formattedLine);
        console.log();
        break;
      case "error":
        console.error(formattedLine);
        console.log();
        break;
    }
  });
}

/**
 * Get ordinal value for log level comparison
 */
function getLogLevelOrdinal(level: AppLogLevel): number {
  switch (level) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warn":
      return 2;
    case "error":
      return 3;
  }
}

/**
 * Get ordinal value from Effect log level label
 */
function getLogLevelOrdinalFromLabel(label: string): number {
  const normalized = label.toLowerCase();
  if (normalized === "trace" || normalized === "debug") {
    return 0;
  } else if (normalized === "info") {
    return 1;
  } else if (normalized === "warning" || normalized === "warn") {
    return 2;
  } else {
    return 3; // error or fatal
  }
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");

/**
 * Create the Effect Logger layer with custom formatting
 *
 * This layer provides the custom Effect logger that will be used by all Effect.log* calls.
 * It should be merged with the app layer in main.ts.
 */
export function createEffectLoggerLayer(
  level: AppLogLevel,
  format: "json" | "pretty",
): Layer.Layer<never, never, never> {
  const customLogger = createPrettyLogger(level, format);
  // Logger.replaceScoped expects an Effect that produces a Logger
  return Logger.replaceScoped(Logger.defaultLogger, Effect.succeed(customLogger));
}

/**
 * Create the logger layer with Effect Logger integration
 *
 * Sets up both the LoggerService (for backward compatibility) and the Effect Logger
 * (for Effect.log* calls) with custom pretty formatting and log level filtering.
 */
export function createLoggerLayer(): Layer.Layer<LoggerService, never, ConfigService> {
  return Layer.effect(
    LoggerServiceTag,
    Effect.gen(function* () {
      // Read config to set up Effect logger
      const config = yield* AgentConfigService;
      const loggingConfig = yield* config.get<{
        level: AppLogLevel;
        format: "json" | "pretty";
      }>("logging");

      const level = loggingConfig?.level ?? "info";
      const format = loggingConfig?.format ?? "pretty";

      // Create and provide the Effect logger layer
      // This ensures all Effect.log* calls use our custom formatting
      const effectLoggerLayer = createEffectLoggerLayer(level, format);
      yield* Effect.provide(Effect.void, effectLoggerLayer);

      return new LoggerServiceImpl();
    }),
  );
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

export function logTaskExecution(
  taskId: string,
  status: "started" | "completed" | "failed",
  meta?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info(`Task ${taskId}: ${status}`, {
      taskId,
      status,
      ...meta,
    });
  });
}

export function logAutomationEvent(
  automationId: string,
  event: string,
  meta?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info(`Automation ${automationId}: ${event}`, {
      automationId,
      event,
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
        const resultString = typeof fullResult === "string"
          ? fullResult
          : JSON.stringify(fullResult, null, 2);

        // Truncate very long results to avoid overwhelming logs
        const maxLength = 10000;
        const truncatedResult = resultString.length > maxLength
          ? resultString.substring(0, maxLength) + `\n... (truncated, ${resultString.length - maxLength} more characters)`
          : resultString;

        yield* logger.writeToFile("info", `Tool result for ${toolName}`, {
          toolName,
          resultLength: resultString.length,
          result: truncatedResult,
        }).pipe(Effect.catchAll(() => Effect.void));
      } catch (error) {
        // If serialization fails, log a warning to file
        yield* logger.writeToFile("warn", `Failed to log full result for ${toolName}`, {
          toolName,
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catchAll(() => Effect.void));
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
  const metaText = meta && Object.keys(meta).length > 0
    ? " " + JSON.stringify(meta, jsonReplacer)
    : "";
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
