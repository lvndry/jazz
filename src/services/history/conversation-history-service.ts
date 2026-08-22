/**
 * Conversation history — the compatibility surface over the session store.
 *
 * The transcript of every conversation lives in an append-only session log
 * (see `session-store.ts`). This module keeps the API its six callers already
 * use, and maintains one small per-agent index file, `{agentId}.json`, holding
 * conversation metadata newest-first.
 *
 * The index is a cache, not a source of truth: it carries no message content and
 * can be deleted or corrupted without losing a conversation, because it is
 * rebuilt from the session logs on the next read. It is also the on-disk shape
 * older Jazz versions expect, which is why it survived the redesign.
 */
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@/core/constants/agent";
import type { ChatMessage } from "@/core/types/message";
import { getHistoryDirectory } from "@/core/utils/paths";
import { withLock, writeFileStringAtomic } from "@/core/utils/storage";
import {
  deleteSession,
  listSessions,
  makeSessionId,
  readSession,
  recordSessionTranscript,
} from "./session-store";

export interface ConversationRecord {
  readonly conversationId: string;
  readonly title: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messageCount: number;
  readonly messages: ChatMessage[];
  /**
   * Session log holding this conversation's transcript. Absent on records written
   * before the session store existed, and on records supplied by callers.
   */
  readonly sessionId?: string;
}

export interface AgentConversationHistory {
  readonly agentId: string;
  readonly conversations: ConversationRecord[];
}

function getAgentHistoryPath(agentId: string, dir?: string): string {
  return path.join(dir ?? getHistoryDirectory(), `${agentId}.json`);
}

function getLockPath(agentId: string, dir?: string): string {
  return path.join(dir ?? getHistoryDirectory(), `${agentId}.lock`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Index entries exactly as they sit on disk, message content included for pre-migration files. */
function readIndexFile(
  agentId: string,
  dir?: string,
): Effect.Effect<ConversationRecord[] | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(getAgentHistoryPath(agentId, dir))
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return null;

    try {
      const parsed = JSON.parse(content) as AgentConversationHistory;
      if (!Array.isArray(parsed?.conversations)) return null;
      return parsed.conversations.filter(
        (conversation) => typeof conversation?.conversationId === "string",
      );
    } catch {
      return null;
    }
  });
}

function writeIndexFile(
  agentId: string,
  conversations: readonly ConversationRecord[],
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* writeFileStringAtomic(
      fs,
      getAgentHistoryPath(agentId, dir),
      JSON.stringify({ agentId, conversations }, null, 2),
      { tempPrefix: "history" },
    );
  });
}

function toIndexEntry(record: ConversationRecord, sessionId: string): ConversationRecord {
  return {
    conversationId: record.conversationId,
    title: record.title,
    agentId: record.agentId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    messageCount: record.messageCount,
    // Transcripts live in the session log; keeping a second copy here is what
    // made every save rewrite the whole conversation.
    messages: [],
    sessionId,
  };
}

/** Rebuilds the index for an agent by reading its session logs, newest first. */
function rebuildIndexFromLogs(
  agentId: string,
  dir?: string,
): Effect.Effect<ConversationRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const sessions = yield* listSessions(dir, agentId);
    const entries: ConversationRecord[] = [];
    for (const session of sessions) {
      const record = yield* readSession(session.sessionId, dir);
      if (!record) continue;
      entries.push({
        conversationId: record.conversationId,
        title: record.title,
        agentId: record.agentId,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        messageCount: record.messages.length,
        messages: [],
        sessionId: record.sessionId,
      });
    }
    return entries.slice(0, MAX_CONVERSATION_HISTORY_PER_AGENT);
  });
}

function readIndexOrRebuild(
  agentId: string,
  dir?: string,
): Effect.Effect<ConversationRecord[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const stored = yield* readIndexFile(agentId, dir);
    if (stored && stored.length > 0) return stored;
    return yield* rebuildIndexFromLogs(agentId, dir);
  });
}

/**
 * Moves pre-session-store history into session logs.
 *
 * Old history kept whole transcripts inside `{agentId}.json`. Each such entry
 * becomes a session log, after which the index only carries metadata. The pass
 * is idempotent — an entry that already has a log is left alone — and it never
 * removes the legacy content until the log it was copied into exists.
 *
 * Callers must hold the agent's lock.
 */
function migrateLegacyIndex(
  agentId: string,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const stored = yield* readIndexFile(agentId, dir);
    if (!stored || stored.length === 0) return;
    if (stored.every((entry) => typeof entry.sessionId === "string")) return;

    const migrated: ConversationRecord[] = [];
    for (const entry of stored) {
      const sessionId = entry.sessionId ?? makeSessionId(agentId, entry.conversationId);
      const existing = yield* readSession(sessionId, dir);
      const messages = Array.isArray(entry.messages) ? entry.messages : [];
      if (!existing && messages.length > 0) {
        yield* recordSessionTranscript(
          {
            agentId,
            conversationId: entry.conversationId,
            title: entry.title,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            messages,
          },
          dir,
        );
      }
      migrated.push(toIndexEntry({ ...entry, agentId }, sessionId));
    }

    yield* writeIndexFile(agentId, migrated, dir);
  });
}

export function saveConversation(
  record: ConversationRecord,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const historyDir = dir ?? getHistoryDirectory();
    yield* fs.makeDirectory(historyDir, { recursive: true }).pipe(Effect.mapError(toError));

    yield* withLock(
      getLockPath(record.agentId, dir),
      Effect.gen(function* () {
        yield* migrateLegacyIndex(record.agentId, dir);

        const sessionId = yield* recordSessionTranscript(
          {
            agentId: record.agentId,
            conversationId: record.conversationId,
            title: record.title,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            messages: record.messages,
          },
          dir,
        );

        const entries = yield* readIndexOrRebuild(record.agentId, dir);
        // Upsert by conversationId: saving an existing conversation replaces its
        // entry and moves it to the front (LRU) instead of duplicating.
        const others = entries.filter(
          (conversation) => conversation.conversationId !== record.conversationId,
        );
        const ordered = [toIndexEntry(record, sessionId), ...others];
        const kept = ordered.slice(0, MAX_CONVERSATION_HISTORY_PER_AGENT);

        for (const evicted of ordered.slice(MAX_CONVERSATION_HISTORY_PER_AGENT)) {
          yield* deleteSession(
            evicted.sessionId ?? makeSessionId(record.agentId, evicted.conversationId),
            dir,
          );
        }

        yield* writeIndexFile(record.agentId, kept, dir);
      }),
    );
  });
}

/** Fills an index entry's transcript in from its session log. */
function hydrate(
  agentId: string,
  entry: ConversationRecord,
  dir?: string,
): Effect.Effect<ConversationRecord, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const sessionId = entry.sessionId ?? makeSessionId(agentId, entry.conversationId);
    const record = yield* readSession(sessionId, dir);
    if (!record) return entry;
    return {
      ...entry,
      sessionId,
      title: entry.title.trim().length > 0 ? entry.title : record.title,
      endedAt: entry.endedAt ?? record.endedAt,
      messageCount: record.messages.length,
      messages: record.messages,
    };
  });
}

export function loadHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    // Reading is the moment an upgrading user first touches their old history, so
    // it is also where migration happens. A failure here (read-only home, lock
    // contention) is not fatal: the legacy entries still carry their transcripts.
    yield* withLock(getLockPath(agentId, dir), migrateLegacyIndex(agentId, dir)).pipe(
      Effect.catchAll(() => Effect.void),
    );

    const entries = yield* readIndexOrRebuild(agentId, dir);
    const conversations: ConversationRecord[] = [];
    for (const entry of entries) {
      conversations.push(yield* hydrate(agentId, entry, dir));
    }
    return { agentId, conversations };
  });
}

export function loadConversation(
  agentId: string,
  conversationId: string,
  dir?: string,
): Effect.Effect<ConversationRecord | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const entries = yield* readIndexFile(agentId, dir);
    const entry = entries?.find((candidate) => candidate.conversationId === conversationId);
    if (entry) return yield* hydrate(agentId, entry, dir);

    // No index entry: the log is still authoritative, so a lost or unwritten
    // index never hides a conversation.
    const record = yield* readSession(makeSessionId(agentId, conversationId), dir);
    if (!record) return null;
    return {
      conversationId: record.conversationId,
      title: record.title,
      agentId: record.agentId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      messageCount: record.messages.length,
      messages: record.messages,
      sessionId: record.sessionId,
    };
  });
}
