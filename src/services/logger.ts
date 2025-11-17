import { Context, Effect, Layer } from "effect";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInstalledGlobally } from "../core/utils/runtime-detection";
import { formatToolArguments } from "../core/utils/tool-formatter";
import { AgentConfigService, type ConfigService } from "./config";

/**
 * Structured logging service using Effect's Logger
 */

export interface LoggerService {
  readonly debug: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never, ConfigService>;
  readonly info: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never, ConfigService>;
  readonly warn: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never, ConfigService>;
  readonly error: (
    message: string,
    meta?: Record<string, unknown>,
  ) => Effect.Effect<void, never, ConfigService>;
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
  ): Effect.Effect<void, never, ConfigService> {
    return Effect.gen(function* () {
      const config = yield* AgentConfigService;
      const loggingConfig = yield* config.get<{
        level: "debug" | "info" | "warn" | "error";
        format: "json" | "pretty";
      }>("logging");
      const level = loggingConfig?.level ?? "info";

      // Only output debug logs if level is "debug"
      if (level !== "debug") {
        return;
      }

      const format = loggingConfig?.format ?? "pretty";

      const line = formatLogLine("debug", message, meta, format);

      console.debug(line);
      console.log();
    });
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never, ConfigService> {
    return Effect.gen(function* () {
      const config = yield* AgentConfigService;
      const loggingConfig = yield* config.get<{
        level: "debug" | "info" | "warn" | "error";
        format: "json" | "pretty";
      }>("logging");
      const level = loggingConfig?.level ?? "info";

      // Only output info logs if level allows it (info, warn, error levels)
      if (!shouldLog(level, "info")) {
        return;
      }

      const format = loggingConfig?.format ?? "pretty";

      const line = formatLogLine("info", message, meta, format);

      console.info(line);
      console.log();
    });
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never, ConfigService> {
    return Effect.gen(function* () {
      const config = yield* AgentConfigService;
      const loggingConfig = yield* config.get<{
        level: "debug" | "info" | "warn" | "error";
        format: "json" | "pretty";
      }>("logging");
      const level = loggingConfig?.level ?? "info";

      // Only output warn logs if level allows it (warn, error levels)
      if (!shouldLog(level, "warn")) {
        return;
      }

      const format = loggingConfig?.format ?? "pretty";

      const line = formatLogLine("warn", message, meta, format);

      console.warn(line);
      console.log();
    });
  }

  error(
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, never, ConfigService> {
    return Effect.gen(function* () {
      const config = yield* AgentConfigService;
      const loggingConfig = yield* config.get<{
        level: "debug" | "info" | "warn" | "error";
        format: "json" | "pretty";
      }>("logging");
      const level = loggingConfig?.level ?? "info";

      // Error logs are always shown regardless of level
      // (but we check for consistency)
      if (!shouldLog(level, "error")) {
        return;
      }

      const format = loggingConfig?.format ?? "pretty";

      const line = formatLogLine("error", message, meta, format);

      console.error(line);
      console.log();
    });
  }
}

type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Check if a log level should be output based on the configured log level.
 * Log levels hierarchy: debug < info < warn < error
 */
function shouldLog(configuredLevel: LogLevel, messageLevel: LogLevel): boolean {
  const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };
  return levels[messageLevel] >= levels[configuredLevel];
}

function formatLogLine(
  level: LogLevel,
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

function selectColor(level: LogLevel): (text: string) => string {
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

function selectEmoji(level: LogLevel): string {
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

export const LoggerServiceTag = Context.GenericTag<LoggerService>("LoggerService");

export function createLoggerLayer(): Layer.Layer<LoggerService, never, ConfigService> {
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
