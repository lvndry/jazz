import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@/core/constants/agent";
import type { ChatMessage } from "@/core/types/message";
import { getHistoryDirectory } from "@/core/utils/paths";
import { withLock, writeFileStringAtomic } from "@/core/utils/storage";

export interface ConversationRecord {
  readonly conversationId: string;
  readonly title: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messageCount: number;
  readonly messages: ChatMessage[];
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

function readHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = getAgentHistoryPath(agentId, dir);

    const content = yield* fs
      .readFileString(filePath)
      .pipe(
        Effect.catchAll((e) =>
          e &&
          typeof e === "object" &&
          "_tag" in e &&
          (e as { _tag: string })._tag === "SystemError" &&
          (e as { reason?: string }).reason === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(e instanceof Error ? e : new Error(String(e))),
        ),
      );

    if (content === "") return { agentId, conversations: [] };

    try {
      const parsed = JSON.parse(content) as AgentConversationHistory;
      return Array.isArray(parsed?.conversations) ? parsed : { agentId, conversations: [] };
    } catch {
      return { agentId, conversations: [] };
    }
  });
}

function writeHistory(
  data: AgentConversationHistory,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = getAgentHistoryPath(data.agentId, dir);
    yield* writeFileStringAtomic(fs, filePath, JSON.stringify(data, null, 2), {
      tempPrefix: "history",
    });
  });
}

export function saveConversation(
  record: ConversationRecord,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const historyDir = dir ?? getHistoryDirectory();
    yield* fs
      .makeDirectory(historyDir, { recursive: true })
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* withLock(
      getLockPath(record.agentId, dir),
      Effect.gen(function* () {
        const history = yield* readHistory(record.agentId, dir);
        // Upsert by conversationId: saving an existing conversation replaces
        // its record and moves it to the front (LRU), instead of duplicating.
        const others = history.conversations.filter(
          (conversation) => conversation.conversationId !== record.conversationId,
        );
        const updated = [record, ...others].slice(0, MAX_CONVERSATION_HISTORY_PER_AGENT);
        yield* writeHistory({ agentId: record.agentId, conversations: updated }, dir);
      }),
    );
  });
}

export function loadHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return readHistory(agentId, dir);
}

export function loadConversation(
  agentId: string,
  conversationId: string,
  dir?: string,
): Effect.Effect<ConversationRecord | null, Error, FileSystem.FileSystem> {
  return readHistory(agentId, dir).pipe(
    Effect.map(
      (history) =>
        history.conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        ) ?? null,
    ),
  );
}
