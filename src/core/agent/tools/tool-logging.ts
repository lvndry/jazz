/**
 * Tool-specific execution logging and formatting.
 *
 * Kept with agent tools so logging policy follows tool execution concerns.
 */
import { Effect } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { formatToolArguments } from "@/core/utils/tool-formatter";

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
    load_skill: "📚",
    execute_command: "⌨️",
    read_file: "📄",
    write_file: "✏️",
    edit_file: "✏️",
    web_search: "🔍",
    http_request: "🌐",
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
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const toolEmoji = getToolEmoji(toolName);
    const duration = formatDuration(durationMs);
    const message = resultSummary
      ? `${toolEmoji} ${toolName} ✅ (${duration}) - ${resultSummary}`
      : `${toolEmoji} ${toolName} ✅ (${duration})`;

    yield* logger.info(message);
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
