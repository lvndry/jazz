/**
 * Decides whether a chat session's history is worth writing to disk, and
 * saves it — skipped for ephemeral sessions or ones with nothing said yet.
 *
 * No title is passed: the log derives it from the first user message, so a
 * conversation is always named by how it opened, even when a session resumes
 * another transcript or the runner hands back a new conversation id.
 */

import { FileSystem } from "@effect/platform";
import {
  saveConversation,
  type Conversation,
  type ConversationUiEntry,
} from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";

export interface PersistConversationInput {
  readonly ephemeral: boolean;
  readonly conversationHistory: readonly ChatMessage[];
  readonly conversationId: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly uiTranscript?: readonly ConversationUiEntry[];
}

export function shouldPersistConversation(input: PersistConversationInput): boolean {
  return (
    !input.ephemeral &&
    (input.conversationHistory.some((message) => message.role === "user") ||
      input.uiTranscript?.some((entry) => entry.type === "user") === true)
  );
}

/**
 * Whether a finished turn's history should be saved. A clean turn always is. A failed
 * turn only when it handed back its work (via `onFailedTurn`), so that work survives the
 * next message and a restart; a failed turn that kept nothing leaves the pre-turn history
 * untouched, as before.
 */
export function shouldSaveTurn(input: {
  readonly lastTurnErrored: boolean;
  readonly turnKeptFailedWork: boolean;
}): boolean {
  return !input.lastTurnErrored || input.turnKeptFailedWork;
}

export function persistConversationIfNeeded(
  input: PersistConversationInput,
  dir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  if (!shouldPersistConversation(input)) {
    return Effect.void;
  }

  const conversation: Conversation = {
    conversationId: input.conversationId,
    title: "",
    agentId: input.agentId,
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    messages: [...input.conversationHistory],
    ...(input.uiTranscript !== undefined ? { uiTranscript: input.uiTranscript } : {}),
  };

  return saveConversation(conversation, dir).pipe(Effect.catchAll(() => Effect.void));
}
