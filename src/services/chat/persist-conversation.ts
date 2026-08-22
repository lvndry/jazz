import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { saveConversation, type ConversationRecord } from "../history/conversation-history-service";

export interface PersistConversationInput {
  readonly ephemeral: boolean;
  readonly conversationTitle: string | null;
  readonly conversationHistory: readonly ChatMessage[];
  readonly conversationId: string;
  readonly agentId: string;
  readonly startedAt: string;
}

export function shouldPersistConversation(input: PersistConversationInput): boolean {
  return (
    !input.ephemeral && input.conversationTitle !== null && input.conversationHistory.length > 0
  );
}

export function persistConversationIfNeeded(
  input: PersistConversationInput,
  dir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  if (!shouldPersistConversation(input) || input.conversationTitle === null) {
    return Effect.void;
  }

  const record: ConversationRecord = {
    conversationId: input.conversationId,
    title: input.conversationTitle,
    agentId: input.agentId,
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    messageCount: input.conversationHistory.length,
    messages: [...input.conversationHistory],
  };

  return saveConversation(record, dir).pipe(Effect.catchAll(() => Effect.void));
}
