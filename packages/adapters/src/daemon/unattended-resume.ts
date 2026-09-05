/**
 * @fileoverview One turn on an existing conversation with nobody at the keyboard — the daemon's
 * two reasons to start one being a job batch finishing and a wake trigger firing.
 *
 * `AgentRunner.run` signals a park by *failing* with `RunParkRequested`, which is not an error:
 * the run stopped on an approval, was persisted, and finishes later via `jazz runs resume <id>`.
 * Both callers used to catch it as a failure, which logged an empty message, skipped the save so
 * the transcript was lost, and told nobody a run was waiting. A park is its own outcome here.
 */

import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { ChatMessage } from "@jazz/core/types/message";
import { sendDesktopNotification } from "@jazz/core/utils/desktop-notify";
import { Effect } from "effect";
import {
  loadConversation,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";

export interface UnattendedTurn {
  readonly agentId: string;
  readonly conversationId: string;
  readonly prompt: string;
  readonly fallbackTitle: string;
  /** Human-readable, for logs and the notification: `"job batch"`, `"wake trigger"`. */
  readonly source: string;
  readonly sourceId: string;
}

/**
 * A parked turn produced real messages up to the approval; dropping them leaves the next turn
 * with no memory of having been woken.
 */
function persist(
  turn: UnattendedTurn,
  startedAt: string | undefined,
  messages: readonly ChatMessage[],
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const now = new Date().toISOString();
    yield* saveConversation({
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      title: turn.fallbackTitle.slice(0, 80),
      startedAt: startedAt ?? now,
      endedAt: now,
      messages: [...messages],
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn(`Unattended ${turn.source} conversation save failed`, {
          agentId: turn.agentId,
          sourceId: turn.sourceId,
          error: error instanceof Error ? error.message : String(error),
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
  | { readonly kind: "failed"; readonly error: string };

export function classifyTurnOutcome(
  result:
    | { readonly ok: true; readonly messages?: readonly ChatMessage[] }
    | { readonly ok: false; readonly error: unknown },
): TurnOutcome {
  if (result.ok) return { kind: "finished", messages: result.messages ?? [] };
  if (!isRunParkRequested(result.error)) {
    return {
      kind: "failed",
      error: result.error instanceof Error ? result.error.message : String(result.error),
    };
  }
  const park = result.error;
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

export function approvalNotification(
  turn: Pick<UnattendedTurn, "source" | "sourceId">,
  parked: Extract<TurnOutcome, { kind: "parked" }>,
): { readonly title: string; readonly body: string } {
  return {
    title: "Jazz needs your approval",
    body: `${turn.source} "${turn.sourceId}" stopped on ${parked.waitingOn}. Run: jazz runs resume ${parked.runId}`,
  };
}

/** A missing agent is logged and dropped rather than retried — there is nothing to resume into. */
export function runUnattendedTurn(turn: UnattendedTurn) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const agentResult = yield* getAgentByIdentifier(turn.agentId).pipe(Effect.either);
    if (agentResult._tag === "Left") {
      yield* logger.warn(`Unattended ${turn.source} skipped: agent not found`, {
        agentId: turn.agentId,
        sourceId: turn.sourceId,
      });
      return;
    }
    const agent = agentResult.right;

    const priorRecord = yield* loadConversation(turn.agentId, turn.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const named = { ...turn, fallbackTitle: priorRecord?.title ?? turn.fallbackTitle };
    const startedAt = priorRecord?.startedAt;

    const outcome = yield* AgentRunner.run({
      agent,
      userInput: turn.prompt,
      conversationId: turn.conversationId,
      parkWhenUnattended: true,
      ...(priorRecord !== null ? { conversationHistory: priorRecord.messages } : {}),
    }).pipe(
      Effect.map((response) =>
        classifyTurnOutcome({
          ok: true,
          ...(response.messages ? { messages: response.messages } : {}),
        }),
      ),
      Effect.catchAll((error) => Effect.succeed(classifyTurnOutcome({ ok: false, error }))),
    );

    switch (outcome.kind) {
      case "failed":
        yield* logger.warn(`Unattended ${turn.source} run failed`, {
          agentId: turn.agentId,
          sourceId: turn.sourceId,
          error: outcome.error,
        });
        return;

      case "unresumable":
        yield* logger.warn(`Unattended ${turn.source} needed approval it could not save`, {
          agentId: turn.agentId,
          sourceId: turn.sourceId,
        });
        return;

      case "parked": {
        yield* logger.info(`Unattended ${turn.source} parked waiting for approval`, {
          agentId: turn.agentId,
          sourceId: turn.sourceId,
          runId: outcome.runId,
          waitingOn: outcome.waitingOn,
          expiresAt: outcome.expiresAt,
          resumeWith: `jazz runs resume ${outcome.runId}`,
        });
        if (outcome.messages !== undefined) {
          yield* persist(named, startedAt, outcome.messages);
        }
        const notification = approvalNotification(turn, outcome);
        yield* sendDesktopNotification(notification.title, notification.body);
        return;
      }

      case "finished":
        yield* persist(
          named,
          startedAt,
          outcome.messages.length > 0 ? outcome.messages : (priorRecord?.messages ?? []),
        );
        return;
    }
  });
}
