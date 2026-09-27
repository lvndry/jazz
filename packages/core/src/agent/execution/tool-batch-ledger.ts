/**
 * What happened to each call of a tool batch, so a batch that is stopped part-way can say so
 * exactly: which calls completed (and what they returned), which were interrupted while they
 * ran, and which never started.
 *
 * The executor records a call as started when its side effect is about to begin: at once for an
 * ordinary tool, after approval for a tool that asks first (a call still waiting for approval
 * has changed nothing). It records the outcome when a call finishes. The agent loop owns the
 * ledger for the batch in flight and reads it whenever the batch ends without every result: an
 * Esc, a run deadline, `--timeout` or SIGTERM.
 */

import type { StoppedToolCall, ToolCall, ToolCallStatus } from "@/core/types/tools";
import type { ToolCallOutcome } from "./tool-executor";

/** The record of one tool batch's calls. */
export class ToolBatchLedger {
  private readonly startedCalls = new Set<string>();
  private readonly finishedCalls = new Map<string, ToolCallOutcome>();

  constructor(readonly toolCalls: readonly ToolCall[]) {}

  /** The call's side effect is about to begin. */
  markStarted(toolCallId: string): void {
    this.startedCalls.add(toolCallId);
  }

  /** The call returned, successfully or not. */
  markFinished(outcome: ToolCallOutcome): void {
    this.startedCalls.add(outcome.toolCallId);
    this.finishedCalls.set(outcome.toolCallId, outcome);
  }

  /** What became of a call, as far as this batch got. */
  statusOf(toolCallId: string): ToolCallStatus {
    if (this.finishedCalls.has(toolCallId)) {
      return "completed";
    }
    return this.startedCalls.has(toolCallId) ? "interrupted" : "not-started";
  }

  /** The result of a call that completed. */
  outcomeOf(toolCallId: string): ToolCallOutcome | undefined {
    return this.finishedCalls.get(toolCallId);
  }

  /** Every call of the batch with its status. */
  report(): readonly StoppedToolCall[] {
    return this.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      status: this.statusOf(toolCall.id),
    }));
  }
}

/**
 * The tool result a stopped call is closed with, telling the model what it may and may not
 * assume. `reason` says what stopped the batch ("stopped by the user", "the run reached its
 * time budget").
 */
export function stoppedToolCallResult(
  status: "interrupted" | "not-started",
  reason: string,
): string {
  return status === "interrupted"
    ? `Interrupted while running (${reason}). It may have made part of its changes: check the current state before relying on it or running it again.`
    : `Not run (${reason}): the batch was stopped before this call started, so it changed nothing.`;
}
