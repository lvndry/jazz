import { Context, Effect, Layer } from "effect";
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
}

export class LoggerServiceImpl implements LoggerService {
  constructor() {}

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
  agentId: string,
  conversationId?: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    yield* logger.info(`${toolEmoji} ${toolName}`, {
      toolName,
      agentId,
      conversationId,
      status: "started",
    });
  });
}

export function logToolExecutionSuccess(
  toolName: string,
  agentId: string,
  durationMs: number,
  conversationId?: string,
  resultSummary?: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = resultSummary
      ? `${toolEmoji} ${toolName} ✅ (${duration}) - ${resultSummary}`
      : `${toolEmoji} ${toolName} ✅ (${duration})`;

    yield* logger.info(message, {
      toolName,
      agentId,
      conversationId,
      durationMs,
      status: "success",
    });
  });
}

export function logToolExecutionError(
  toolName: string,
  agentId: string,
  durationMs: number,
  error: string,
  conversationId?: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ✗ (${duration}) - ${error}`;

    yield* logger.error(message, {
      toolName,
      agentId,
      conversationId,
      durationMs,
      status: "error",
      error,
    });
  });
}

export function logToolExecutionApproval(
  toolName: string,
  agentId: string,
  durationMs: number,
  approvalMessage: string,
  conversationId?: string,
): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ⚠️ APPROVE REQUIRED (${duration}) - ${approvalMessage}`;

    yield* logger.warn(message, {
      toolName,
      agentId,
      conversationId,
      durationMs,
      status: "approval_required",
      approvalMessage,
    });
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
