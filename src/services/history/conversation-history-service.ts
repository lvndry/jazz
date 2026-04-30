import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import {
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
  MAX_CONVERSATION_HISTORY_PER_AGENT,
} from "@/core/constants/agent";
import { getHistoryDirectory } from "@/core/utils/runtime-detection";
import type { ChatMessage } from "@/core/types/message";

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

function acquireLock(
  lockPath: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let attempt = 0; attempt < FILE_LOCK_MAX_RETRIES; attempt++) {
      const acquired = yield* fs
        .makeDirectory(lockPath, { recursive: false })
        .pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        );
      if (acquired) return;

      const statResult = yield* fs.stat(lockPath).pipe(Effect.option);
      const stat = Option.getOrNull(statResult);
      const mtimeMs = Option.match(stat?.mtime ?? Option.none(), {
        onNone: () => 0,
        onSome: (d) => d.getTime(),
      });
      if (stat && Date.now() - mtimeMs > FILE_LOCK_TIMEOUT_MS) {
        yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        continue;
      }
      yield* Effect.sleep(FILE_LOCK_RETRY_DELAY_MS);
    }
    return yield* Effect.fail(new Error("Failed to acquire history lock after retries"));
  });
}

function releaseLock(lockPath: string): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
  });
}

function withLock<A, E, R>(
  agentId: string,
  dir: string | undefined,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> {
  const lockPath = getLockPath(agentId, dir);
  return Effect.acquireUseRelease(
    acquireLock(lockPath),
    () => operation,
    () => releaseLock(lockPath),
  );
}

function readHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = getAgentHistoryPath(agentId, dir);

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.catchAll((e) =>
        e && typeof e === "object" && "_tag" in e &&
        (e as { _tag: string })._tag === "SystemError" &&
        (e as { reason?: string }).reason === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(e instanceof Error ? e : new Error(String(e))),
      ),
    );

    if (content === "") return { agentId, conversations: [] };

    try {
      const parsed = JSON.parse(content) as AgentConversationHistory;
      return Array.isArray(parsed?.conversations)
        ? parsed
        : { agentId, conversations: [] };
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
    const directory = path.dirname(filePath);
    const tmpPath = path.join(
      directory,
      `.history-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs
      .writeFileString(tmpPath, JSON.stringify(data, null, 2))
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs.rename(tmpPath, filePath).pipe(
      Effect.tapError(() => fs.remove(tmpPath).pipe(Effect.catchAll(() => Effect.void))),
      Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

export function saveConversation(
  record: ConversationRecord,
  dir?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return withLock(
    record.agentId,
    dir,
    Effect.gen(function* () {
      const history = yield* readHistory(record.agentId, dir);
      const updated = [record, ...history.conversations].slice(
        0,
        MAX_CONVERSATION_HISTORY_PER_AGENT,
      );
      yield* writeHistory({ agentId: record.agentId, conversations: updated }, dir);
    }),
  );
}

export function loadHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return readHistory(agentId, dir);
}
