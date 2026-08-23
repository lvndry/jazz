/**
 * @fileoverview Continue a run that parked waiting for a person.
 *
 * Resuming replays the batch the run stopped on rather than re-entering the executor
 * halfway through it. That is why parking is restricted to a lone tool call: with nothing
 * else in the batch, replaying it is exactly one tool running exactly once, and the
 * approval it needs is already answered.
 */

import { Effect } from "effect";
import { AgentServiceTag } from "@/core/interfaces/agent-service";
import { RunStoreTag } from "@/core/interfaces/run-store";
import type { ApprovalOutcome } from "@/core/types/tools";
import { AgentRunner } from "../agent-runner";
import type { AgentResponse } from "../types";
import type { RunId } from "./run-state";

export class RunNotResumableError extends Error {
  constructor(
    readonly runId: RunId,
    reason: string,
  ) {
    super(`Run ${runId} cannot be resumed: ${reason}`);
    this.name = "RunNotResumableError";
  }
}

export interface ResumeRunOptions {
  readonly runId: RunId;
  readonly outcome: ApprovalOutcome;
  readonly sessionId: string;
  /** Approve tools of the same kind for the rest of the resumed run, as an interactive session would. */
  readonly autoApprovedTools?: readonly string[];
}

export function resumeRun(options: ResumeRunOptions) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const agentService = yield* AgentServiceTag;

    const record = yield* store.get(options.runId);
    if (record === undefined) {
      return yield* Effect.fail(new RunNotResumableError(options.runId, "no such run"));
    }
    if (record.state.kind !== "input-required") {
      return yield* Effect.fail(
        new RunNotResumableError(
          options.runId,
          `it is ${record.state.kind}, and only a run waiting on input can be resumed`,
        ),
      );
    }
    if (record.state.pending.kind !== "tool-approval") {
      return yield* Effect.fail(
        new RunNotResumableError(options.runId, "it is waiting on an answer, not an approval"),
      );
    }

    const { snapshot, pending } = record.state;
    const agent = yield* agentService
      .getAgent(record.agentId)
      .pipe(
        Effect.mapError(
          () => new RunNotResumableError(options.runId, `its agent ${record.agentId} is gone`),
        ),
      );

    // Claimed before the work starts: two approvals racing on the same parked run would
    // otherwise both replay the tool, and the transition table rejects the second.
    yield* store
      .transition(options.runId, { kind: "working", iteration: snapshot.iteration })
      .pipe(
        Effect.mapError(
          (error) =>
            new RunNotResumableError(options.runId, `it was already claimed (${error.message})`),
        ),
      );

    const response: AgentResponse = yield* AgentRunner.run({
      agent,
      runId: options.runId,
      userInput: "",
      isResume: true,
      conversationId: record.conversationId,
      sessionId: options.sessionId,
      conversationHistory: [...snapshot.messages],
      resolvedApprovals: new Map([[pending.request.toolCallId, options.outcome]]),
      parkWhenUnattended: true,
      ...(options.autoApprovedTools !== undefined
        ? { autoApprovedTools: options.autoApprovedTools }
        : {}),
    });

    return response;
  });
}
