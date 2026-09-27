/**
 * @fileoverview Continue a run that parked waiting for a person.
 *
 * Resuming replays the batch the run stopped on rather than re-entering the executor
 * halfway through it. That is why parking is restricted to a lone tool call: with nothing
 * else in the batch, replaying it is exactly one tool running exactly once, and the
 * approval it needs is already answered.
 */

import { Effect, Option } from "effect";
import type { ProviderName } from "@/core/constants/models";
import { AgentServiceTag } from "@/core/interfaces/agent-service";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { RunStoreTag } from "@/core/interfaces/run-store";
import type { RunBudget } from "@/core/types/remote-door";
import type { ApprovalOutcome, AutoApprovePolicy } from "@/core/types/tools";
import { currentProcessOwner } from "@/core/utils/process";
import { AgentRunner } from "../agent-runner";
import type { AgentResponse, RunStarter } from "../types";
import type { RunRecord } from "./run-record";
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
  /** Preserve an unattended caller's authority ceiling across the park; overrides the policy stored on the run. */
  readonly autoApprovePolicy?: AutoApprovePolicy;
  /** What the resumed segment may spend; a goal or loop passes what its budget has left. */
  readonly maxTokens?: number;
  readonly maxCostUSD?: number;
  readonly maxDurationMs?: number;
  readonly maxIterations?: number;
  readonly withholdInteractiveTools?: boolean;
  /** What started the run, so the resumed segment keeps the tools that come with it. */
  readonly startedBy?: RunStarter;
  /**
   * Provider keys for this resumed segment only, layered over the agent's own. A long-lived
   * host process resolves them per segment so a key stored after it started still applies.
   */
  readonly providerApiKeys?: Partial<Record<ProviderName, string>>;
}

/**
 * Whether answering a parked run with `outcome` grants it anything. Only a rejected approval
 * grants nothing: approving runs the tool, and answering or declining a question or a file
 * picker lets the run carry on past the point it stopped to ask about.
 */
export function answerGrantsSomething(outcome: ResumeRunOptions["outcome"]): boolean {
  return outcome.kind !== "approval" || outcome.value.approved;
}

/** The smaller of two optional caps, or whichever one is set. */
function tighterCap(recorded: number | undefined, requested: number | undefined) {
  if (recorded === undefined) {
    return requested;
  }
  return requested === undefined ? recorded : Math.min(recorded, requested);
}

/**
 * What the run's recorded budget has left after the segments that already ran, or which cap is
 * already used up. A cap applies to the whole run, so a resumed segment gets the remainder rather
 * than the full amount again.
 */
export function remainingRunBudget(record: RunRecord): {
  readonly budget: RunBudget;
  readonly exhausted?: "token" | "cost" | "time";
} {
  const recorded = record.boundary?.budget;
  if (recorded === undefined) {
    return { budget: {} };
  }
  const maxTokens =
    recorded.maxTokens === undefined ? undefined : recorded.maxTokens - (record.totalTokens ?? 0);
  const maxCostUSD =
    recorded.maxCostUSD === undefined ? undefined : recorded.maxCostUSD - (record.costUSD ?? 0);
  const maxDurationMs =
    recorded.maxDurationMs === undefined
      ? undefined
      : recorded.maxDurationMs - (record.activeDurationMs ?? 0);
  const budget: RunBudget = {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
  };
  if (maxTokens !== undefined && maxTokens <= 0) {
    return { budget, exhausted: "token" };
  }
  if (maxCostUSD !== undefined && maxCostUSD <= 0) {
    return { budget, exhausted: "cost" };
  }
  if (maxDurationMs !== undefined && maxDurationMs <= 0) {
    return { budget, exhausted: "time" };
  }
  return { budget };
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

    const boundary = record.boundary ?? {};
    if (boundary.remoteCaller !== undefined && boundary.toolAllowlist === undefined) {
      return yield* Effect.fail(
        new RunNotResumableError(
          options.runId,
          `the ${boundary.remoteCaller.door} "${boundary.remoteCaller.name}" started it and its tool boundary was not recorded`,
        ),
      );
    }
    const remaining = remainingRunBudget(record);
    if (remaining.exhausted !== undefined) {
      return yield* Effect.fail(
        new RunNotResumableError(options.runId, `its ${remaining.exhausted} budget is spent`),
      );
    }
    const maxTokens = tighterCap(remaining.budget.maxTokens, options.maxTokens);
    const maxCostUSD = tighterCap(remaining.budget.maxCostUSD, options.maxCostUSD);
    const maxDurationMs = tighterCap(remaining.budget.maxDurationMs, options.maxDurationMs);
    const withholdInteractiveTools =
      boundary.withholdInteractiveTools === true || options.withholdInteractiveTools === true;

    const { snapshot, pending } = record.state;
    const storedAgent = yield* agentService
      .getAgent(record.agentId)
      .pipe(
        Effect.mapError(
          () => new RunNotResumableError(options.runId, `its agent ${record.agentId} is gone`),
        ),
      );
    const agent =
      options.providerApiKeys === undefined
        ? storedAgent
        : {
            ...storedAgent,
            config: {
              ...storedAgent.config,
              llmApiKeys: { ...storedAgent.config.llmApiKeys, ...options.providerApiKeys },
            },
          };

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

    // Claim only after validating the complete snapshot. Two approvals racing on the same
    // parked run still cannot replay the tool because the transition is atomic.
    yield* store
      .transition(options.runId, {
        kind: "working",
        iteration: snapshot.iteration,
        owner: currentProcessOwner(),
        recovery: {
          pending,
          snapshot,
          expiresAt: record.state.expiresAt,
          ...currentProcessOwner(),
        },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RunNotResumableError(options.runId, `it was already claimed (${error.message})`),
        ),
      );

    // Everything this turn has already been answered, plus the answer just given. Building
    // the map from the new answer alone was the bug: a turn needing two approvals would stop
    // on the first, then on the second, then on the first again, because each resume had
    // forgotten the round before it.
    const alreadyAnswered = Object.entries(snapshot.pendingTurnAnswers ?? {});
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

    if (record.workingDirectory !== undefined) {
      const fileSystemContext = yield* Effect.serviceOption(FileSystemContextServiceTag);
      if (Option.isSome(fileSystemContext)) {
        yield* fileSystemContext.value
          .setCwd(
            { agentId: record.agentId, conversationId: record.conversationId },
            record.workingDirectory,
          )
          .pipe(
            Effect.mapError(
              () =>
                new RunNotResumableError(
                  options.runId,
                  `the directory it worked in, ${record.workingDirectory}, is gone`,
                ),
            ),
          );
      }
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
      ...(record.approvalPolicy !== undefined ? { autoApprovePolicy: record.approvalPolicy } : {}),
      ...(record.maxIterations !== undefined ? { maxIterations: record.maxIterations } : {}),
      ...(options.autoApprovePolicy !== undefined
        ? { autoApprovePolicy: options.autoApprovePolicy }
        : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(withholdInteractiveTools ? { withholdInteractiveTools: true } : {}),
      ...(boundary.toolAllowlist !== undefined ? { toolAllowlist: boundary.toolAllowlist } : {}),
      ...(boundary.disablePersistence === true ? { disablePersistence: true } : {}),
      ...(boundary.remoteCaller !== undefined
        ? { remoteCaller: boundary.remoteCaller, ingestUserInputPaths: false }
        : {}),
      ...(options.startedBy !== undefined ? { startedBy: options.startedBy } : {}),
      ...(record.autoApprovedTools !== undefined || options.autoApprovedTools !== undefined
        ? {
            autoApprovedTools: [
              ...new Set([
                ...(record.autoApprovedTools ?? []),
                ...(options.autoApprovedTools ?? []),
              ]),
            ],
          }
        : {}),
    });

    return response;
  });
}
