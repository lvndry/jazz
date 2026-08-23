/**
 * Conversation history: reading, saving, and keeping the directory bounded.
 *
 * Everything durable lives in the logs themselves (`./conversation-log`). This module adds
 * the two policies on top: how many conversations an agent keeps, and what a caller gets
 * when it asks for a list rather than a transcript.
 *
 * It used to maintain a per-agent index file as well, with a lock file, an atomic rewrite,
 * a rebuild-from-logs fallback and a legacy migration. All of it existed to avoid reading
 * the logs — and then the read path hydrated every log anyway, so it bought nothing while
 * adding a second source of truth that could disagree with the first. Reading an entire
 * history is single-digit milliseconds; the directory is the index.
 */

import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@/core/constants/agent";
import {
  deleteConversationLog,
  listConversationLogs,
  readConversationLog,
  recordConversationTranscript,
  summarize,
  type Conversation,
  type ConversationSummary,
} from "./conversation-log";

export type { Conversation, ConversationSummary } from "./conversation-log";

export interface AgentConversationHistory {
  readonly agentId: string;
  readonly conversations: ConversationSummary[];
}

/**
 * Saves a conversation, then trims the agent back to its retention limit.
 *
 * Eviction reads modification times rather than a stored order: the newest logs are the
 * ones worth keeping, and the filesystem already tracks that.
 */
export function saveConversation(
  conversation: Conversation,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    yield* recordConversationTranscript(
      {
        agentId: conversation.agentId,
        conversationId: conversation.conversationId,
        title: conversation.title,
        startedAt: conversation.startedAt,
        endedAt: conversation.endedAt,
        messages: conversation.messages,
      },
      dir,
    );

    const logs = yield* listConversationLogs(conversation.agentId, dir);
    for (const stale of logs.slice(MAX_CONVERSATION_HISTORY_PER_AGENT)) {
      yield* deleteConversationLog(stale.agentId, stale.conversationId, dir);
    }
  });
}

/**
 * One agent's conversations, newest first, without their transcripts.
 *
 * Summaries rather than conversations because a listing is what this is for. A caller that
 * needs what was said asks for one conversation by id, instead of every transcript on disk
 * being read to draw a picker.
 */
export function loadHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const logs = yield* listConversationLogs(agentId, dir);
    const conversations: ConversationSummary[] = [];
    for (const log of logs.slice(0, MAX_CONVERSATION_HISTORY_PER_AGENT)) {
      const conversation = yield* readConversationLog(log.agentId, log.conversationId, dir);
      if (conversation) conversations.push(summarize(conversation));
    }
    return { agentId, conversations };
  });
}

/** One conversation with everything said in it, or null when there is no log for it. */
export function loadConversation(
  agentId: string,
  conversationId: string,
  dir?: string,
): Effect.Effect<Conversation | null, Error, FileSystem.FileSystem> {
  return readConversationLog(agentId, conversationId, dir);
}
