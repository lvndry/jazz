/**
 * Tool-specific execution logging and formatting.
 *
 * Kept with agent tools so logging policy follows tool execution concerns.
 */
import { Effect } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";

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
 * Record the start without copying model supplied arguments into a diagnostic
 * message. The separate local audit receipt records their safe shape.
 */
export function logToolExecutionStart(
  _toolName: string,
  _args?: Record<string, unknown>,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.debug("Tool execution started", {
      eventName: "tool.execution.started",
    });
  });
}

/**
 * Record a successful tool execution. The summary and full result are
 * deliberately excluded because either can contain arbitrary user content.
 */
export function logToolExecutionSuccess(
  _toolName: string,
  durationMs: number,
  _resultSummary?: string,
  _fullResult?: unknown,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info("Tool execution completed", {
      eventName: "tool.execution.completed",
      durationMs,
      status: "success",
    });
  });
}

/**
 * Log tool execution error
 */
export function logToolExecutionError(
  _toolName: string,
  durationMs: number,
  _error: string,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.error("Tool execution failed", {
      eventName: "tool.execution.failed",
      durationMs,
      status: "failure",
    });
  });
}

/**
 * Log tool execution approval required
 */
export function logToolExecutionApproval(
  _toolName: string,
  durationMs: number,
  _approvalMessage: string,
): Effect.Effect<void, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* logger.info("Tool approval required", {
      eventName: "tool.approval.required",
      durationMs,
      status: "awaiting_approval",
    });
  });
}
