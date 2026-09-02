/**
 * @fileoverview Continue a run that parked waiting for a person.
 *
 * Resuming replays the batch the run stopped on rather than re-entering the executor
 * halfway through it. That is why parking is restricted to a lone tool call: with nothing
 * else in the batch, replaying it is exactly one tool running exactly once, and the
 * approval it needs is already answered.
 */

import { hostname } from "node:os";
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
  readonly outcome:
    | { readonly kind: "approval"; readonly value: ApprovalOutcome }
    | {
        readonly kind: "question";
        readonly value:
          { readonly kind: "answered"; readonly response: string } | { readonly kind: "declined" };
      }
    | {
        readonly kind: "file-picker";
        readonly value:
          { readonly kind: "selected"; readonly path: string } | { readonly kind: "cancelled" };
      };
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
    const expectedOutcomeKind =
      record.state.pending.kind === "tool-approval" ? "approval" : record.state.pending.kind;
    if (expectedOutcomeKind !== options.outcome.kind) {
      return yield* Effect.fail(
        new RunNotResumableError(options.runId, "its pending input has a different kind"),
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
      .transition(options.runId, {
        kind: "working",
        iteration: snapshot.iteration,
        // Kept so a resume that dies mid-flight can be re-parked rather than stranded.
        recovery: {
          pending,
          snapshot,
          expiresAt: record.state.expiresAt,
          pid: process.pid,
          host: hostname(),
        },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RunNotResumableError(options.runId, `it was already claimed (${error.message})`),
        ),
      );

    // The turn stopped on an assistant message whose tool calls never got results. Those
    // are what resume has to finish; anything already answered stays answered.
    const lastAssistant = [...snapshot.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    const answered = new Set(
      snapshot.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    const pendingToolCalls = (lastAssistant?.tool_calls ?? []).filter(
      (toolCall) => !answered.has(toolCall.id),
    );

    if (pendingToolCalls.length === 0) {
      return yield* Effect.fail(
        new RunNotResumableError(
          options.runId,
          "its transcript has no unanswered tool call to finish",
        ),
      );
    }

    // Every approval this turn has already collected, plus the one just given. Building the
    // map from the new answer alone was the bug: a turn needing two approvals would stop on
    // the first, then on the second, then on the first again, because each resume had
    // forgotten the round before it.
    const alreadyAnswered = Object.entries(snapshot.answeredApprovals ?? {});
    const resolved =
      options.outcome.kind === "approval" && pending.kind === "tool-approval"
        ? {
            resolvedApprovals: new Map([
              ...alreadyAnswered,
              [pending.request.toolCallId, options.outcome.value] as const,
            ]),
          }
        : options.outcome.kind === "question" && pending.kind === "question"
          ? { resolvedUserInputs: new Map([[pending.toolCallId, options.outcome.value]]) }
          : options.outcome.kind === "file-picker" && pending.kind === "file-picker"
            ? { resolvedFilePickers: new Map([[pending.toolCallId, options.outcome.value]]) }
            : undefined;
    if (resolved === undefined) {
      return yield* Effect.fail(
        new RunNotResumableError(options.runId, "its pending input has a different kind"),
      );
    }

    const response: AgentResponse = yield* AgentRunner.run({
      agent,
      runId: options.runId,
      userInput: "",
      isResume: true,
      conversationId: record.conversationId,
      conversationHistory: [...snapshot.messages],
      pendingToolCalls,
      ...resolved,
      parkWhenUnattended: true,
      ...(options.autoApprovedTools !== undefined
        ? { autoApprovedTools: options.autoApprovedTools }
        : {}),
    });

    return response;
  });
}
