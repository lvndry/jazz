/**
 * @fileoverview Answering a parked run, whoever it belongs to.
 *
 * A run a goal or a loop started is resumed under what that goal or loop still allows, and its
 * result is folded back into it; any other run is resumed on its own. Every surface that
 * answers runs (chat, `jazz runs`, `jazz goal`, the daemon) goes through here, so an answer
 * never bypasses the budget or bookkeeping of the thing that started the run.
 */

import { resumeRun, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import { describePendingInput } from "@jazz/core/daemon/attention";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { Effect } from "effect";
import { resumeGoalRun } from "./goal-worker";
import { resumeLoopRun } from "./loop-worker";

export function resumeOwnedRun(options: ResumeRunOptions) {
  return Effect.gen(function* () {
    const goal = yield* resumeGoalRun(options);
    if (goal !== undefined) {
      return goal;
    }
    const loop = yield* resumeLoopRun(options);
    if (loop !== undefined) {
      return loop;
    }
    const response = yield* resumeRun(options);
    return { kind: "unowned", response } as const;
  });
}

/** What a parked run waits on from the user, in words, or undefined when it is not parked. */
export function pendingRunInput(runId: string) {
  return Effect.gen(function* () {
    const runs = yield* RunStoreTag;
    const run = yield* runs.get(runId);
    if (run?.state.kind !== "input-required") {
      return undefined;
    }
    const pending = run.state.pending;
    return {
      kind: pending.kind,
      runId: run.runId,
      described: describePendingInput(pending),
    } as const;
  });
}

export type PendingRunInput = NonNullable<
  Effect.Effect.Success<ReturnType<typeof pendingRunInput>>
>;

/** What a person answers a goal's or loop's waiting run with. */
export type RunAnswer =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly note?: string }
  | { readonly kind: "answer"; readonly response: string };

/**
 * `answer` as the outcome a parked run resumes with, or why it does not fit what the run waits
 * on: an approval is approved or rejected, a question is answered.
 */
export function runAnswerOutcome(
  pending: PendingRunInput,
  answer: RunAnswer,
):
  | { readonly kind: "outcome"; readonly outcome: ResumeRunOptions["outcome"] }
  | { readonly kind: "mismatch"; readonly reason: string } {
  const wantsApproval = pending.kind === "tool-approval";
  if (wantsApproval !== (answer.kind !== "answer")) {
    return {
      kind: "mismatch",
      reason: wantsApproval
        ? "It is waiting for an approval, not an answer: approve or reject it."
        : "It is waiting for an answer to its question, not an approval.",
    };
  }
  return {
    kind: "outcome",
    outcome:
      answer.kind === "answer"
        ? { kind: "question", value: { kind: "answered", response: answer.response } }
        : {
            kind: "approval",
            value:
              answer.kind === "approve"
                ? { approved: true }
                : {
                    approved: false,
                    ...(answer.note !== undefined ? { userMessage: answer.note } : {}),
                  },
          },
  };
}
