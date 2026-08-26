/**
 * @fileoverview The durable half of a run.
 *
 * `AgentRunMetrics` already knows a run's identity, when it started, and what it spent —
 * and then emits it to telemetry and forgets it. This is the part that outlives the
 * process, so a caller who was not there can still ask what happened.
 *
 * The transcript is deliberately absent. Messages live in the session log, keyed by
 * conversation, and a record that copied them would be a second thing to keep in step
 * with the first. The one exception is a parked run, whose turn never finished and is
 * therefore not in the session log at all — that snapshot rides inside the state and is
 * dropped the moment the run resumes.
 */

import type { TokenUsage } from "@/core/interfaces/telemetry";
import type { RunId, RunState } from "./run-state";

export interface RunRecord {
  readonly runId: RunId;
  readonly agentId: string;
  /** Shared with every other run in the same conversation, and with the session log. */
  readonly conversationId: string;
  readonly state: RunState;
  /** The prompt that started the run, kept so a listing can be read without opening the transcript. */
  readonly input: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly costUSD?: number;
  readonly tokenUsage?: TokenUsage;
}

/**
 * How long a parked run waits for a person before it is abandoned.
 *
 * Long, because parking is free: a run blocked on an approval holds no context window and
 * spends nothing per hour. The deadline exists so an unanswered run eventually stops
 * appearing in listings, not to protect a budget. A day covers "approve it when I wake
 * up", which is the case this feature exists for.
 */
export const DEFAULT_PARK_TTL_MS = 24 * 60 * 60 * 1000;

export function createRunRecord(input: {
  readonly runId: RunId;
  readonly agentId: string;
  readonly conversationId: string;
  readonly input: string;
  readonly now: Date;
}): RunRecord {
  const timestamp = input.now.toISOString();
  return {
    runId: input.runId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    state: { kind: "submitted" },
    input: input.input,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
