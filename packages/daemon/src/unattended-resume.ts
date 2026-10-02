/**
 * @fileoverview One turn on an existing conversation with nobody at the keyboard — the daemon's
 * two reasons to start one being a job batch finishing and a wake trigger firing.
 *
 * `AgentRunner.run` signals a park by *failing* with `RunParkRequested`, which is not an error:
 * the run stopped on an approval, was persisted, and finishes later via `jazz runs approve <id>` or `jazz runs reject <id>`.
 * Both callers used to catch it as a failure, which logged an empty message, skipped the save so
 * the transcript was lost, and told nobody a run was waiting. A park is its own outcome here.
 */

import {
  loadConversationOrNull,
  saveRunTranscript,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import {
  isRetryableAnswerFailure,
  judgeAnswer,
  ranTools,
  type AnswerFailureCode,
} from "@jazz/core/agent/run/answer-outcome";
import { classifyRunError } from "@jazz/core/agent/run/park-signal";
import type { AgentResponse } from "@jazz/core/agent/types";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { enqueueNotification, notifyTargets } from "@jazz/core/notify/outbox";
import type { SpendSource } from "@jazz/core/spend/sources";
import type { ChatMessage } from "@jazz/core/types/message";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { Effect } from "effect";

export type UnattendedTurnSource = "job batch" | "wake trigger";

/** Where a turn's spend lands in the ledger, and how the notify channel names it. */
const TURN_SPEND_SOURCES: Readonly<Record<UnattendedTurnSource, SpendSource>> = {
  "job batch": "job",
  "wake trigger": "wake-trigger",
};

export interface UnattendedTurn {
  readonly agentId: string;
  readonly conversationId: string;
  readonly prompt: string;
  readonly fallbackTitle: string;
  /** Human-readable, for logs and the notification. */
  readonly source: UnattendedTurnSource;
  readonly sourceId: string;
}

function logSource(source: string): "job_batch" | "wake_trigger" | "other" {
  if (source === "job batch") return "job_batch";
  if (source === "wake trigger") return "wake_trigger";
  return "other";
}

/**
 * A parked turn produced real messages up to the approval; dropping them leaves the next turn
 * with no memory of having been woken.
 */
function persist(
  turn: UnattendedTurn,
  prior: Conversation | null,
  messages: readonly ChatMessage[],
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    yield* saveRunTranscript({
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      prior,
      fallbackTitle: turn.fallbackTitle,
      messages,
    }).pipe(
      Effect.catchAll(() =>
        logger.warn("Unattended conversation save failed", {
          source: logSource(turn.source),
          errorType: "save_failed",
        }),
      ),
    );
  });
}

/**
 * A park arrives as a *failure*. Telling it apart from a real one is why this is its own
 * function: reading `parked` as `failed` is what lost the transcript and hid the waiting run.
 */
export type TurnOutcome =
  | { readonly kind: "finished"; readonly messages: readonly ChatMessage[] }
  | {
      readonly kind: "parked";
      readonly runId: string;
      readonly waitingOn: string;
      readonly expiresAt: string | undefined;
      readonly messages: readonly ChatMessage[] | undefined;
    }
  /** Parked, but never persisted, so there is no run to point anybody at. */
  | { readonly kind: "unresumable" }
  /**
   * The run ended without a usable answer (see `judgeAnswer`). `ranTools` says whether it
   * called tools before that, which makes running the prompt again repeat their effects.
   */
  | {
      readonly kind: "unanswered";
      readonly code: AnswerFailureCode;
      readonly error: string;
      readonly ranTools: boolean;
      readonly messages: readonly ChatMessage[];
    }
  | { readonly kind: "failed"; readonly error: string };

/** A run that returned normally, judged: finished with an answer, or unanswered. */
export function classifyTurnResponse(
  response: Pick<
    AgentResponse,
    | "content"
    | "artifacts"
    | "finishReason"
    | "emptyCompletion"
    | "interrupted"
    | "iterationLimited"
    | "costCapped"
    | "tokenCapped"
    | "durationCapped"
    | "toolCalls"
    | "messages"
  >,
): TurnOutcome {
  const messages = response.messages ?? [];
  const verdict = judgeAnswer(response);
  if (verdict.kind === "failed") {
    return {
      kind: "unanswered",
      code: verdict.code,
      error: verdict.message,
      ranTools: ranTools(response),
      messages,
    };
  }
  return classifyTurnOutcome({ ok: true, messages });
}

export function classifyTurnOutcome(
  result:
    | { readonly ok: true; readonly messages?: readonly ChatMessage[] }
    | { readonly ok: false; readonly error: unknown },
): TurnOutcome {
  if (result.ok) return { kind: "finished", messages: result.messages ?? [] };
  const ending = classifyRunError(result.error);
  if (ending.kind === "failed") {
    return ending;
  }
  const { park } = ending;
  if (park.runId === undefined) return { kind: "unresumable" };
  return {
    kind: "parked",
    runId: park.runId,
    waitingOn:
      park.pending.kind === "tool-approval" ? park.pending.request.toolName : park.pending.kind,
    expiresAt: park.expiresAt,
    messages: park.messages,
  };
}

/**
 * What a turn's outcome means for the item that caused it (a wake trigger, a batch's fan-in):
 * finishing and parking both delivered it (a park is persisted and the daemon announces it), while
 * a failure keeps the item for a retry, with the error text. A run that called tools and then
 * gave no answer counts as delivered, because a retry would repeat what those tools did; its
 * transcript is saved so the conversation shows what ran. A content-filtered answer is kept
 * without a retry, since the filter withholds it every time.
 */
export function turnDeliveryOutcome(outcome: TurnOutcome): DeliveryOutcome {
  switch (outcome.kind) {
    case "finished":
    case "parked":
      return { delivered: true };
    case "unresumable":
      return {
        delivered: false,
        error: "The run stopped for an approval, but its state could not be saved to resume it.",
        retryable: true,
      };
    case "unanswered":
      if (outcome.ranTools) {
        return { delivered: true };
      }
      return {
        delivered: false,
        error: outcome.error,
        retryable: isRetryableAnswerFailure(outcome.code),
      };
    case "failed":
      return { delivered: false, error: outcome.error, retryable: true };
  }
}

/**
 * Tell the person a turn ended without delivering its item. A failed run is reported by the run's
 * own accounting; the endings that reach no run exit (an approval that could not be saved, an
 * answer that never came) would otherwise leave a wake trigger or batch failed in silence, and
 * nothing may be running to retry it. One notice per item, however often it is retried.
 */
function notifyTurnNotDelivered(turn: UnattendedTurn, error: string) {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const appConfig = yield* config.appConfig;
    yield* enqueueNotification(
      notifyTargets(appConfig),
      {
        kind: "unattended-failed",
        source: TURN_SPEND_SOURCES[turn.source],
        name: turn.sourceId,
        agentId: turn.agentId,
        error,
      },
      { dedupeKey: `undelivered:${turn.source}:${turn.agentId}:${turn.sourceId}` },
    );
  }).pipe(Effect.ignore);
}

/**
 * Run one unattended turn and report whether it delivered the item that caused it. A missing
 * agent fails without retrying, since there is nothing to resume into.
 */
export function runUnattendedTurn(turn: UnattendedTurn) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const agentResult = yield* getAgentByIdentifier(turn.agentId).pipe(Effect.either);
    if (agentResult._tag === "Left") {
      yield* logger.warn("Unattended run skipped: agent not found", {
        source: logSource(turn.source),
        errorType: "agent_not_found",
      });
      const missingAgent: DeliveryOutcome = {
        delivered: false,
        error: `Agent "${turn.agentId}" was not found.`,
        retryable: false,
      };
      return missingAgent;
    }
    const agent = agentResult.right;

    const priorRecord = yield* loadConversationOrNull(turn.agentId, turn.conversationId);

    const outcome = yield* AgentRunner.run({
      agent,
      userInput: turn.prompt,
      conversationId: turn.conversationId,
      parkWhenUnattended: true,
      origin: { source: TURN_SPEND_SOURCES[turn.source], name: turn.sourceId },
      ...(priorRecord !== null ? { conversationHistory: priorRecord.messages } : {}),
    }).pipe(
      Effect.map(classifyTurnResponse),
      Effect.catchAll((error) => Effect.succeed(classifyTurnOutcome({ ok: false, error }))),
    );

    switch (outcome.kind) {
      case "failed":
        yield* logger.warn("Unattended run failed", {
          source: logSource(turn.source),
          errorType: "run_failed",
          error: outcome.error,
        });
        break;

      case "unanswered":
        yield* logger.warn(
          outcome.ranTools
            ? "Unattended run called tools but gave no answer; not retrying"
            : "Unattended run gave no answer",
          {
            source: logSource(turn.source),
            errorType: outcome.code,
            error: outcome.error,
          },
        );
        if (outcome.ranTools && outcome.messages.length > 0) {
          yield* persist(turn, priorRecord, outcome.messages);
        }
        break;

      case "unresumable":
        yield* logger.warn("Unattended run could not save required approval", {
          source: logSource(turn.source),
          errorType: "approval_save_failed",
        });
        break;

      case "parked": {
        yield* logger.info("Unattended run parked waiting for approval", {
          source: logSource(turn.source),
          status: "awaiting_approval",
        });
        if (outcome.messages !== undefined) {
          yield* persist(turn, priorRecord, outcome.messages);
        }
        // The daemon's notifier announces every parked run, with how to answer it.
        break;
      }

      case "finished":
        yield* persist(
          turn,
          priorRecord,
          outcome.messages.length > 0 ? outcome.messages : (priorRecord?.messages ?? []),
        );
        break;
    }
    const delivery = turnDeliveryOutcome(outcome);
    if (!delivery.delivered && outcome.kind !== "failed") {
      yield* notifyTurnNotDelivered(turn, delivery.error);
    }
    return delivery;
  });
}
