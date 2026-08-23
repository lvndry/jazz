/**
 * @fileoverview The lifecycle of one agent execution.
 *
 * A run is one turn: one `AgentRunner.run`, one `jazz run`, one message handled by a
 * bridge. It has always existed — this module gives it a name, an identity, and a shape
 * that survives the process executing it.
 *
 * Three things in jazz sound like this one and are not:
 *
 * - `TaskState` (`../context/task-state.ts`) is what the *model* believes about the work:
 *   goal, next step, which items it thinks are done. It is authored by a tool call, it can
 *   be wrong, and one of them spans many runs in a conversation.
 * - `ActivityState` (`@/cli/ui/activity-state`) is what the *terminal* is drawing this
 *   frame. It never leaves the process and never reaches disk.
 * - A session is the whole conversation, keyed by `(agentId, conversationId)` and holding
 *   every message ever exchanged. A run is one turn inside one.
 *
 * A run state is none of those: it is a fact about an execution, written by the runtime,
 * and it is what an external caller polls to learn whether work is alive, blocked, or
 * over.
 */

import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ChatMessage } from "@/core/types/message";
import type { ApprovalRequest } from "@/core/types/tools";

/**
 * Identifier for a single run.
 *
 * Distinct from `conversationId`, which many runs share, and from `sessionId`, which is
 * derived from the conversation and is therefore equally shared.
 */
export type RunId = string;

/** Why a run reached a terminal failure, for callers that branch on it rather than read prose. */
export type RunFailureCause =
  | "error"
  | "timeout"
  | "max-iterations"
  /** Parked waiting for a person, and nobody answered before the run's park deadline. */
  | "abandoned";

/** What a parked run is waiting for. */
export type PendingInput =
  | {
      readonly kind: "tool-approval";
      /**
       * The approval the run stopped on. `toolCallId` is what an external approver
       * answers with, and is already carried for exactly that purpose.
       */
      readonly request: ApprovalRequest;
    }
  | {
      readonly kind: "question";
      readonly prompt: string;
    };

/**
 * Everything needed to pick a parked run back up in a different process.
 *
 * The transcript of an unfinished turn is not in the session log yet — the history
 * service writes it once the turn completes — so the snapshot here is its only copy
 * rather than a second one. It is deleted when the run resumes, which keeps the session
 * log the single source of truth for every turn that actually finished.
 */
export interface ParkedRunSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly iteration: number;
}

export type RunState =
  | { readonly kind: "submitted" }
  | {
      readonly kind: "working";
      readonly iteration: number;
      /**
       * Carried by a resumed run so a crash cannot swallow it.
       *
       * Claiming a parked run moves it to `working`, and the snapshot it was parked with is
       * the only copy of an unfinished turn. If the resuming process dies before the run
       * reaches a terminal state, this is what lets it be parked again instead of stranded
       * as a `working` run nobody is working on.
       */
      readonly recovery?: {
        readonly pending: PendingInput;
        readonly snapshot: ParkedRunSnapshot;
        readonly expiresAt: string;
        /**
         * The process doing the work.
         *
         * A dead pid is a fact; "it has been quiet for a while" is a guess, and a run can
         * legitimately sit in one tool call for an hour. Only a pid lets recovery tell a
         * crashed resume from a slow one without ever re-parking a run that is still going.
         * Only meaningful on the machine that wrote it.
         */
        readonly pid: number;
        readonly host: string;
      };
    }
  | {
      readonly kind: "input-required";
      readonly pending: PendingInput;
      readonly snapshot: ParkedRunSnapshot;
      /** After this instant the run is abandoned. A parked run burns no tokens, so this is generous. */
      readonly expiresAt: string;
    }
  | {
      readonly kind: "completed";
      readonly content: string;
      readonly artifacts?: readonly GeneratedArtifact[];
    }
  | { readonly kind: "failed"; readonly cause: RunFailureCause; readonly error: string }
  | { readonly kind: "canceled"; readonly at: "queued" | "working" | "parked" };

export type RunStateKind = RunState["kind"];

const TERMINAL_KINDS = new Set<RunStateKind>(["completed", "failed", "canceled"]);

/**
 * Blocked on a person, resumable, and burning nothing while it waits.
 *
 * A set rather than an equality check because parking is a category, not a state: a run
 * blocked on a missing credential belongs here too, once something detects one.
 */
const PARKED_KINDS = new Set<RunStateKind>(["input-required"]);

export function isTerminal(state: RunState): boolean {
  return TERMINAL_KINDS.has(state.kind);
}

export function isParked(state: RunState): boolean {
  return PARKED_KINDS.has(state.kind);
}

/**
 * Which states may follow which.
 *
 * Two absences are deliberate. Terminal states lead nowhere, so a finished run can never
 * be revived under its own id. And a parked run cannot go straight to `completed`: it has
 * to pass back through `working`, because the answer has to be produced by an agent that
 * actually resumed rather than by whoever supplied the approval.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RunStateKind, readonly RunStateKind[]>> = {
  submitted: ["working", "canceled", "failed"],
  working: ["input-required", "completed", "failed", "canceled"],
  "input-required": ["working", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: RunStateKind, to: RunStateKind): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunStateKind,
    readonly to: RunStateKind,
  ) {
    super(`A run cannot move from "${from}" to "${to}".`);
    this.name = "InvalidRunTransitionError";
  }
}

/**
 * Apply a transition, or throw when it is not one the lifecycle permits.
 *
 * Throwing rather than returning the old state keeps an illegal move loud: a caller that
 * tries to complete a canceled run has a bug, and silently keeping `canceled` would hide
 * it behind correct-looking output.
 */
export function transition(from: RunState, to: RunState): RunState {
  if (!canTransition(from.kind, to.kind)) {
    throw new InvalidRunTransitionError(from.kind, to.kind);
  }
  return to;
}
