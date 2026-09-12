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
} from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";

export interface PersistConversationInput {
  readonly ephemeral: boolean;
  readonly conversationHistory: readonly ChatMessage[];
  readonly conversationId: string;
  readonly agentId: string;
  readonly startedAt: string;
}

export function shouldPersistConversation(input: PersistConversationInput): boolean {
  return !input.ephemeral && input.conversationHistory.some((message) => message.role === "user");
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
  };

  return saveConversation(conversation, dir).pipe(Effect.catchAll(() => Effect.void));
}
