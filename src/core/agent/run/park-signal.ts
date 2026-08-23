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
import type { PendingInput } from "./run-state";

export class RunParkRequested extends Data.TaggedError("RunParkRequested")<{
  readonly pending: PendingInput;
  /** Attached by the agent loop on the way out; absent while the signal is still inside the executor. */
  readonly messages?: readonly ChatMessage[];
  readonly iteration?: number;
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
  return new RunParkRequested({ pending: signal.pending, messages, iteration });
}
