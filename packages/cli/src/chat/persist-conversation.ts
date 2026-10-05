/**
 * Decides whether a chat session's history is worth writing to disk, and
 * saves it — skipped for ephemeral sessions or empty, unnamed conversations. Succeeds with
 * the revision the log is at after the save, or null when nothing was saved.
 *
 * Explicit session titles are preserved without truncation. Otherwise the log derives its
 * title from the first user message. Naming an empty conversation makes it worth saving too.
 */

import { FileSystem } from "@effect/platform";
import {
  saveConversation,
  type ConversationRevision,
  type ConversationToSave,
  type SaveConversationOptions,
  type ConversationUiEntry,
} from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";

export interface PersistConversationInput {
  readonly ephemeral: boolean;
  readonly conversationHistory: readonly ChatMessage[];
  readonly conversationId: string;
  readonly title?: string | undefined;
  readonly agentId: string;
  readonly startedAt: string;
  readonly uiTranscript?: readonly ConversationUiEntry[];
  /** The saved revision the session built this history on. */
  readonly basedOn: ConversationRevision;
}

export function shouldPersistConversation(input: PersistConversationInput): boolean {
  return (
    !input.ephemeral &&
    ((input.title?.trim().length ?? 0) > 0 ||
      input.conversationHistory.some((message) => message.role === "user") ||
      input.uiTranscript?.some((entry) => entry.content.kind === "user") === true)
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
  options?: SaveConversationOptions,
): Effect.Effect<ConversationRevision | null, Error, FileSystem.FileSystem> {
  if (!shouldPersistConversation(input)) {
    return Effect.succeed(null);
  }

  const conversation: ConversationToSave = {
    conversationId: input.conversationId,
    title: input.title ?? "",
    agentId: input.agentId,
    startedAt: input.startedAt,
    messages: [...input.conversationHistory],
    ...(input.uiTranscript !== undefined ? { uiTranscript: input.uiTranscript } : {}),
    basedOn: input.basedOn,
  };

  return saveConversation(conversation, dir, options);
}
