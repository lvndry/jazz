import { Effect } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { formatToolArguments } from "./tool-formatter";

/**
 * Helper functions for tool execution logging
 * These functions format messages and use LoggerService directly
 */

/**
 * Custom replacer for JSON.stringify to handle BigInt values
 */
export function jsonBigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

/**
 * Get emoji for a tool based on its name
 */
export function getToolEmoji(toolName: string): string {
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

/**
 * Format duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60_000);
    const seconds = ((ms % 60_000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Log tool execution start
 */
export function logToolExecutionStart(
  toolName: string,
  args?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const argsText = formatToolArguments(toolName, args, { style: "plain" });
    const message = argsText ? `${toolEmoji} ${toolName} ${argsText}` : `${toolEmoji} ${toolName}`;
    yield* logger.info(message);
  });
}

/**
 * Log tool execution success
 */
export function logToolExecutionSuccess(
  toolName: string,
  durationMs: number,
  resultSummary?: string,
  fullResult?: unknown,
): Effect.Effect<void, never, LoggerService> {
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
        const maxLength = 10_000;
        const truncatedResult =
          resultString.length > maxLength
            ? resultString.substring(0, maxLength) +
              `\n... (truncated, ${resultString.length - maxLength} more characters)`
            : resultString;

        yield* logger
          .info(`Tool result for ${toolName}`, {
            toolName,
            resultLength: resultString.length,
            result: truncatedResult,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      } catch (error) {
        // If serialization fails, log a warning to file
        yield* logger
          .warn(`Failed to log full result for ${toolName}`, {
            toolName,
            error: error instanceof Error ? error.message : String(error),
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }
  });
}

/**
 * Log tool execution error
 */
export function logToolExecutionError(
  toolName: string,
  durationMs: number,
  error: string,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ✗ (${duration}) - ${error}`;

    yield* logger.error(message);
  });
}

/**
 * Log tool execution approval required
 */
export function logToolExecutionApproval(
  toolName: string,
  durationMs: number,
  approvalMessage: string,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = `${toolEmoji} ${toolName} ⚠️ APPROVE REQUIRED (${duration}) - ${approvalMessage}`;

    yield* logger.warn(message);
  });
}
