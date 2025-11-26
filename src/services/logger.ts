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
  private readonly conversationIdRef: Ref.Ref<Option.Option<string>>;

  constructor(conversationId?: string) {
    this.conversationIdRef = Ref.unsafeMake(
      conversationId ? Option.some(conversationId) : Option.none(),
    );
  }

  /**
   * Set the conversation ID for this logger instance
   * All subsequent logs will be written to the conversation-specific file
   */
  setConversationId(conversationId: string): Effect.Effect<void, never> {
    return Ref.set(this.conversationIdRef, Option.some(conversationId));
  }

  /**
   * Clear the conversation ID
   * Subsequent logs will be written to the general log file
   */
  clearConversationId(): Effect.Effect<void, never> {
    return Ref.set(this.conversationIdRef, Option.none());
  }

  writeToFile(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): Effect.Effect<void, Error> {
    const conversationIdRef = this.conversationIdRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(conversationIdRef);
      return yield* Effect.tryPromise({
        try: () => {
          if (Option.isSome(conversationId)) {
            return writeFormattedLogToConversationFile(level, conversationId.value, message, meta);
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
    const conversationIdRef = this.conversationIdRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(conversationIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToConversationFile("debug", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("debug", message, meta);
        }
      });
    });
  }

  info(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const conversationIdRef = this.conversationIdRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(conversationIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToConversationFile("info", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("info", message, meta);
        }
      });
    });
  }

  warn(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const conversationIdRef = this.conversationIdRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(conversationIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToConversationFile("warn", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("warn", message, meta);
        }
      });
    });
  }

  error(message: string, meta?: Record<string, unknown>): Effect.Effect<void, never> {
    const conversationIdRef = this.conversationIdRef;
    return Effect.gen(function* () {
      const conversationId = yield* Ref.get(conversationIdRef);
      return yield* Effect.sync(() => {
        if (Option.isSome(conversationId)) {
          void writeFormattedLogToConversationFile("error", conversationId.value, message, meta);
        } else {
          void writeFormattedLogToFile("error", message, meta);
        }
      });
    });
  }
}

/**
 * Create the logger layer
 *
 * Creates a single logger instance that can dynamically scope logs to conversations
 * using setConversationId() and clearConversationId() methods.
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
 * Writes to the general jazz.log file (used when no conversationId is set)
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
 * Write a formatted log line to a conversation-specific file
 * Creates a separate log file per conversation ID: conversation-{conversationId}.log
 */
async function writeFormattedLogToConversationFile(
  level: "debug" | "info" | "warn" | "error",
  conversationId: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const logsDir = getLogsDirectory();
  await mkdir(logsDir, { recursive: true });
  // Sanitize conversationId for use in filename (remove invalid characters)
  const sanitizedId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = path.join(logsDir, `conversation_${sanitizedId}.log`);
  const line = formatLogLineForFile(level, message, meta);
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
