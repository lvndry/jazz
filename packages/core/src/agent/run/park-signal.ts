/**
 * @fileoverview The signal that unwinds a run so it can be picked up later.
 *
 * Parking cannot be an `ApprovalOutcome`. An outcome is something the tool executor
 * consumes and carries on from — approved, or declined with a note for the model. Parking
 * is the opposite: nothing can continue, because the answer is going to arrive in another
 * process, possibly tomorrow. So it leaves as a failure and is caught by the runner, which
 * is the only layer that knows the run's identity and can persist it.
 *
 * It travels in two hops. The tool executor knows *what* the run is waiting for but not
 * the conversation around it; the agent loop knows the messages but not why anyone
 * stopped. The executor raises the signal, the loop catches it and attaches the
 * transcript, and the runner turns the result into a parked record.
 */

import { Data } from "effect";
import type { ChatMessage } from "@/core/types/message";
import type { ApprovalOutcome } from "@/core/types/tools";
import type { PendingInput } from "./run-state";

export class RunParkRequested extends Data.TaggedError("RunParkRequested")<{
  readonly pending: PendingInput;
  /**
   * This turn's answers so far, raised with the signal so they survive the park.
   *
   * Every reconstruction of this signal must carry it — see `withTranscript`, which builds
   * a new one from a handful of named fields and would otherwise drop this silently.
   */
  readonly pendingTurnAnswers?: Readonly<Record<string, ApprovalOutcome>>;
  /** Attached by the agent loop on the way out; absent while the signal is still inside the executor. */
  readonly messages?: readonly ChatMessage[];
  readonly iteration?: number;
  /**
   * Attached last, by the recorder, once the run is actually saved. Their absence means
   * the park was raised but never persisted, so nothing can be resumed and the caller
   * should treat it as a plain failure.
   */
  readonly runId?: string;
  readonly expiresAt?: string;
  /**
   * What the run spent before it stopped.
   *
   * A parked run has already paid for every token it burned getting to the approval, the
   * same way a timed-out run has. Reporting zero would tell an unattended deployment the
   * work was free.
   */
  readonly costUSD?: number;
}> {}

export function isRunParkRequested(error: unknown): error is RunParkRequested {
  return error instanceof RunParkRequested;
}

/**
 * Attach the transcript to a signal raised deeper down.
 *
 * Only a top-level run parks. A sub-agent that parked would have to be resumed by
 * replaying a child context that no longer exists anywhere, so sub-agents keep declining
 * as they always have and their parent reasons about the refusal. The first-attachment
 * guard is therefore belt-and-braces: it keeps an unexpected nested raise from
 * overwriting the transcript that actually belongs to the approval.
 */
export function withTranscript(
  signal: RunParkRequested,
  messages: readonly ChatMessage[],
  iteration: number,
): RunParkRequested {
  if (signal.messages !== undefined) return signal;
  return new RunParkRequested({
    pending: signal.pending,
    ...(signal.pendingTurnAnswers !== undefined
      ? { pendingTurnAnswers: signal.pendingTurnAnswers }
      : {}),
    messages,
    iteration,
  });
}
