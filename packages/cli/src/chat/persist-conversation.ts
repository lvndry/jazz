import { FileSystem } from "@effect/platform";
import {
  saveConversation,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";

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

  const conversation: Conversation = {
    conversationId: input.conversationId,
    title: input.conversationTitle,
    agentId: input.agentId,
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    messages: [...input.conversationHistory],
  };

  return saveConversation(conversation, dir).pipe(Effect.catchAll(() => Effect.void));
}
