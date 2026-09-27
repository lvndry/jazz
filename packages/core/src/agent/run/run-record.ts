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
import type { RemoteCaller, RunBudget } from "@/core/types/remote-door";
import type { AutoApprovePolicy } from "@/core/types/tools";
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
  /** Prompt plus completion tokens, retained for aggregate goal budget reconciliation. */
  readonly totalTokens?: number;
  /** Active execution time across resumes; waiting for approval is excluded. */
  readonly activeDurationMs?: number;
  /**
   * The authority the run started with. A resumed run gets exactly this back, so answering
   * one approval neither drops a granted tier nor widens a narrower one to the default.
   */
  readonly approvalPolicy?: AutoApprovePolicy;
  readonly autoApprovedTools?: readonly string[];
  /** The run's iteration cap, which a resumed run keeps rather than falling back to the default. */
  readonly maxIterations?: number;
  /** Where the run worked, restored on resume instead of the resuming process's directory. */
  readonly workingDirectory?: string;
  /**
   * The rest of the boundary the run started inside, restored exactly on resume. Answering one
   * approval must not hand a webhook's run the agent's whole toolset, its operator context, or
   * an unlimited budget.
   */
  readonly boundary?: RunRecordBoundary;
  /**
   * Set when nobody could be asked while it started (the daemon, a headless run), as opposed
   * to a chat. The daemon's daily spend cap counts only these.
   */
  readonly unattended?: boolean;
}

/** The limits beyond the approval policy that a resumed run gets back. */
export interface RunRecordBoundary {
  /** The ceiling on the run's toolset. Absent means the agent's own tools. */
  readonly toolAllowlist?: readonly string[];
  readonly withholdInteractiveTools?: boolean;
  readonly disablePersistence?: boolean;
  /** Set when a remote door started the run. A remote run without a `toolAllowlist` is refused. */
  readonly remoteCaller?: RemoteCaller;
  /** The caps the whole run shares. A resumed segment gets what the earlier ones left. */
  readonly budget?: RunBudget;
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
  readonly approvalPolicy?: AutoApprovePolicy;
  readonly autoApprovedTools?: readonly string[];
  readonly maxIterations?: number;
  readonly workingDirectory?: string;
  readonly boundary?: RunRecordBoundary;
  readonly unattended?: boolean;
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
    ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.autoApprovedTools !== undefined && input.autoApprovedTools.length > 0
      ? { autoApprovedTools: input.autoApprovedTools }
      : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.boundary !== undefined && Object.keys(input.boundary).length > 0
      ? { boundary: input.boundary }
      : {}),
    ...(input.unattended === true ? { unattended: true } : {}),
  };
}
