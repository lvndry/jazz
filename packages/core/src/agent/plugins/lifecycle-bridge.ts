/**
 * Maps in-run StreamEvents to plugin lifecycle events. Kept pure so the mapping is unit-tested
 * without a live run; the caller emits the result fire-and-forget. Only a subset of StreamEvents is
 * bridged — tool execution, approval, and sub-agent brackets — and payloads are bounded.
 */

import type { JsonValue, LifecycleEventId } from "@/core/types/plugin";
import type { StreamEvent } from "@/core/types/streaming";

export interface BridgedLifecycleEvent {
  readonly event: LifecycleEventId;
  readonly data?: Readonly<Record<string, JsonValue>>;
}

const MAX_FIELD_CHARS = 2000;

function clip(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

/**
 * The lifecycle event a StreamEvent should raise, or undefined when it isn't bridged. `tool-end`
 * vs `tool-error` follows the completion's success flag; `permission-denied` fires only on a
 * declined approval (an approval is otherwise observed as `permission-request`).
 */
export function lifecycleEventForStreamEvent(
  event: StreamEvent,
): BridgedLifecycleEvent | undefined {
  switch (event.type) {
    case "tool_execution_start":
      return {
        event: "tool-start",
        data: { tool: event.toolName, toolCallId: event.toolCallId },
      };
    case "tool_execution_complete":
      return event.success === false
        ? {
            event: "tool-error",
            data: {
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              error: clip(event.error ?? "tool failed"),
            },
          }
        : {
            event: "tool-end",
            data: {
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              ...(event.summary === undefined ? {} : { summary: clip(event.summary) }),
            },
          };
    case "approval_required":
      return {
        event: "permission-request",
        data: {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.riskLevel === undefined ? {} : { riskLevel: event.riskLevel }),
        },
      };
    case "approval_resolved":
      return event.approved
        ? undefined
        : {
            event: "permission-denied",
            data: { tool: event.toolName, toolCallId: event.toolCallId, auto: event.auto },
          };
    case "subagent_start":
      return {
        event: "subagent-start",
        data: {
          ...(event.agentName === undefined ? {} : { agentName: event.agentName }),
          ...(event.task === undefined ? {} : { task: clip(event.task) }),
        },
      };
    case "subagent_complete":
      return {
        event: "subagent-stop",
        data: {
          ...(event.agentName === undefined ? {} : { agentName: event.agentName }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        },
      };
    default:
      return undefined;
  }
}
