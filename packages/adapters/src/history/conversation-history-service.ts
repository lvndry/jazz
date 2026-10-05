/**
 * Conversation history: reading, saving, and keeping the live history bounded.
 *
 * Everything durable lives in the logs themselves (`./conversation-log`). This module adds
 * the policies on top: how many conversations an agent keeps, where the older ones go, and
 * what a caller gets when it asks for a list rather than a transcript.
 *
 * It used to maintain a per-agent index file as well, with a lock file, an atomic rewrite,
 * a rebuild-from-logs fallback and a legacy migration. All of it existed to avoid reading
 * the logs — and then the read path hydrated every log anyway, so it bought nothing while
 * adding a second source of truth that could disagree with the first. Reading an entire
 * history is single-digit milliseconds; the directory is the index.
 *
 * Saving still needs a per-agent lock around append+list+archive: unlocked, two concurrent
 * saves could each list before the other's append lands, miscounting the retention limit.
 *
 * Retention archives rather than deletes. Past `history.maxConversationsPerAgent` (100 by
 * default, set once at startup through `setConversationRetentionLimit`), the least recently
 * saved conversations are compressed into `history/archive/conversations/`, except any a
 * goal, loop or run record still names: those are the long-lived conversations an unattended
 * worker comes back to, and archiving one would strand it. Each archived conversation is
 * logged. When the goal, loop and run records cannot be read, nothing is archived that save.
 *
 * The first save of a process also moves files from the history format that predates
 * per-agent conversation directories (`history/<agent>.json` indexes and the flat
 * `history/sessions/` logs, which nothing reads any more) into `history/archive/legacy/`.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { assertConversationWritable } from "@jazz/core/agent/detach/ownership";
import { MAX_CONVERSATION_HISTORY_PER_AGENT } from "@jazz/core/constants/agent";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { ChatMessage } from "@jazz/core/types/message";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { toError } from "@jazz/core/utils/errors";
import { getHistoryDirectory } from "@jazz/core/utils/paths";
import { stateDirectoryMode } from "@jazz/core/utils/private-mode";
import { withLock } from "@jazz/core/utils/storage";
import { Effect, Option } from "effect";
import {
  agentConversationLockPath,
  archiveConversationLog,
  ConversationChangedError,
  conversationRevision,
  countConversationLogs,
  EMPTY_CONVERSATION_REVISION,
  getHistoryArchiveDirectory,
  listConversationLogs,
  readConversationLog,
  recordConversationTranscript,
  recordLeafMove,
  summarize,
  type Conversation,
  type ConversationRevision,
  type ConversationSummary,
  type ConversationToSave,
} from "./conversation-log";
import { FileGoalStore } from "../storage/goal-store";
import { FileLoopStore } from "../storage/loop-store";
import { FileRunStore } from "../storage/run-store";

export type {
  Conversation,
  ConversationRevision,
  ConversationSummary,
  ConversationToSave,
  ConversationUiEntry,
} from "./conversation-log";
export {
  ConversationChangedError,
  conversationRevision,
  displayConversationTitle,
  EMPTY_CONVERSATION_REVISION,
  readConversationBranches,
  sameRevision,
  savedConversationRevision,
} from "./conversation-log";
export type { ConversationBranch } from "./conversation-tree";

export interface AgentConversationHistory {
  readonly agentId: string;
  readonly conversations: ConversationSummary[];
}

let conversationRetentionLimit = MAX_CONVERSATION_HISTORY_PER_AGENT;
/**
 * Sets how many conversations each agent keeps in its live history, from
 * `history.maxConversationsPerAgent`. Unset restores the default.
 */
export function setConversationRetentionLimit(limit: number | undefined): void {
  conversationRetentionLimit = limit ?? MAX_CONVERSATION_HISTORY_PER_AGENT;
}

/** How many conversations each agent keeps in its live history. */
export function getConversationRetentionLimit(): number {
  return conversationRetentionLimit;
}

/** Answers which of an agent's conversations a goal, loop or run still names. */
export type ConversationsInUse = (agentId: string) => Effect.Effect<ReadonlySet<string>, Error>;

/** Reads the goal, loop and run records under `$JAZZ_HOME`. */
export const conversationsInUseByRecords: ConversationsInUse = (agentId) =>
  Effect.gen(function* () {
    const goals = yield* new FileGoalStore().list({ agentId });
    const loops = yield* new FileLoopStore().list({ agentId });
    const runs = yield* new FileRunStore().list({ agentId, includeTerminal: true });
    const inUse = new Set<string>();
    for (const record of [...goals, ...loops]) {
      inUse.add(record.conversationId);
      if (record.sourceConversationId !== undefined) {
        inUse.add(record.sourceConversationId);
      }
    }
    for (const run of runs) {
      inUse.add(run.conversationId);
    }
    return inUse;
  }).pipe(Effect.catchAllDefect((defect) => Effect.fail(toError(defect))));

export interface SaveConversationOptions {
  readonly fenceHeldBy?: string;
  /** Overrides the goal, loop and run lookup; tests pass a fixed set. */
  readonly conversationsInUse?: ConversationsInUse;
  /**
   * False skips archiving legacy files and conversations beyond the retention limit. A save
   * made mid-turn runs once per agent-loop iteration, and the save at the end of the turn
   * does the archiving.
   */
  readonly housekeeping?: boolean;
}

function logHousekeeping(
  level: "info" | "warn",
  message: string,
  meta: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.flatMap(Effect.serviceOption(LoggerServiceTag), (logger) =>
    Option.match(logger, {
      onNone: () => Effect.void,
      onSome: (service) => service[level](message, meta),
    }),
  );
}

/**
 * Archives the agent's least recently saved conversations beyond the retention limit,
 * skipping any a goal, loop or run still names. Returns the archived conversation ids.
 */
function archiveBeyondRetention(
  agentId: string,
  dir: string | undefined,
  conversationsInUse: ConversationsInUse,
): Effect.Effect<readonly string[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    // Counting names is one directory read; listing reads every log's header, which only an
    // agent over its limit needs.
    if ((yield* countConversationLogs(agentId, dir)) <= conversationRetentionLimit) {
      return [];
    }
    const logs = yield* listConversationLogs(agentId, dir);
    const candidates = logs.slice(conversationRetentionLimit);
    if (candidates.length === 0) {
      return [];
    }

    const inUse = yield* conversationsInUse(agentId).pipe(Effect.either);
    if (inUse._tag === "Left") {
      yield* logHousekeeping(
        "warn",
        "Conversation retention skipped: goal, loop and run records could not be read",
        { agentId, error: inUse.left.message },
      );
      return [];
    }

    const archived: string[] = [];
    for (const stale of candidates) {
      if (inUse.right.has(stale.conversationId)) {
        continue;
      }
      const archivePath = yield* archiveConversationLog(stale.agentId, stale.conversationId, dir);
      if (archivePath === null) {
        continue;
      }
      archived.push(stale.conversationId);
      yield* logHousekeeping("info", "Archived conversation beyond the retention limit", {
        agentId: stale.agentId,
        conversationId: stale.conversationId,
        archivePath,
        retentionLimit: conversationRetentionLimit,
      });
    }
    return archived;
  });
}

const LEGACY_SESSIONS_DIRECTORY_NAME = "sessions";
const LEGACY_INDEX_EXTENSION = ".json";
const LEGACY_ARCHIVE_DIRECTORY_NAME = "legacy";

const legacyHistoryChecked = new Set<string>();

/**
 * Moves files from the history format that predates per-agent conversation directories into
 * `history/archive/legacy/`, once per process per history directory. Nothing reads them;
 * moving rather than deleting keeps them recoverable by hand.
 */
export function archiveLegacyHistory(
  dir?: string,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem> {
  const historyDirectory = dir ?? getHistoryDirectory();
  if (legacyHistoryChecked.has(historyDirectory)) {
    return Effect.succeed([]);
  }
  legacyHistoryChecked.add(historyDirectory);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(historyDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const legacyNames: string[] = [];
    for (const name of names) {
      const info = yield* fs
        .stat(path.join(historyDirectory, name))
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      const isLegacyIndex = info?.type === "File" && name.endsWith(LEGACY_INDEX_EXTENSION);
      const isLegacySessions =
        info?.type === "Directory" && name === LEGACY_SESSIONS_DIRECTORY_NAME;
      if (isLegacyIndex || isLegacySessions) {
        legacyNames.push(name);
      }
    }
    if (legacyNames.length === 0) {
      return [];
    }

    const legacyArchive = path.join(
      getHistoryArchiveDirectory(historyDirectory),
      LEGACY_ARCHIVE_DIRECTORY_NAME,
    );
    yield* fs.makeDirectory(legacyArchive, { recursive: true, mode: stateDirectoryMode() });
    const moved: string[] = [];
    for (const name of legacyNames) {
      const destination = path.join(legacyArchive, name);
      const exists = yield* fs.exists(destination);
      if (exists) {
        continue;
      }
      yield* fs.rename(path.join(historyDirectory, name), destination);
      moved.push(destination);
    }
    if (moved.length > 0) {
      yield* logHousekeeping("info", "Moved unread legacy history files into the archive", {
        moved,
      });
    }
    return moved;
  }).pipe(
    Effect.catchAll((error) =>
      logHousekeeping("warn", "Legacy history cleanup failed", {
        error: toError(error).message,
      }).pipe(Effect.as([] as readonly string[])),
    ),
  );
}

/**
 * Saves a conversation, then archives the agent's oldest conversations beyond the retention
 * limit (see the file header).
 *
 * Retention reads modification times rather than a stored order: the most recently saved
 * logs are the ones worth keeping, and the filesystem already tracks that.
 */
export function saveConversation(
  conversation: ConversationToSave,
  dir?: string,
  options?: SaveConversationOptions,
): Effect.Effect<ConversationRevision, Error, FileSystem.FileSystem> {
  const lockPath = agentConversationLockPath(conversation.agentId, dir);
  const conversationsInUse = options?.conversationsInUse ?? conversationsInUseByRecords;
  const assertWritable = () =>
    Effect.tryPromise({
      try: () =>
        assertConversationWritable(
          conversation.agentId,
          conversation.conversationId,
          options?.fenceHeldBy,
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  return Effect.gen(function* () {
    const housekeeping = options?.housekeeping !== false;
    yield* assertWritable();
    if (housekeeping) {
      yield* archiveLegacyHistory(dir);
    }

    return yield* withLock(
      lockPath,
      Effect.gen(function* () {
        yield* assertWritable();
        const revision = yield* recordConversationTranscript(
          {
            agentId: conversation.agentId,
            conversationId: conversation.conversationId,
            title: conversation.title,
            startedAt: conversation.startedAt,
            messages: conversation.messages,
            basedOn: conversation.basedOn,
            ...(conversation.uiTranscript !== undefined
              ? { uiTranscript: conversation.uiTranscript }
              : {}),
          },
          dir,
        );

        if (housekeeping) {
          yield* archiveBeyondRetention(conversation.agentId, dir, conversationsInUse);
        }
        return revision;
      }),
    );
  });
}

/**
 * Continue a conversation from another entry (see `recordLeafMove`), under the same lock as a
 * save so it never lands between another writer's read and write.
 */
export function moveConversationLeaf(
  input: {
    readonly agentId: string;
    readonly conversationId: string;
    readonly to: string | null;
    readonly basedOn: ConversationRevision;
  },
  dir?: string,
): Effect.Effect<Conversation, Error, FileSystem.FileSystem> {
  return withLock(agentConversationLockPath(input.agentId, dir), recordLeafMove(input, dir));
}

/**
 * One agent's conversations, most recently spoken in first, without their transcripts.
 *
 * Summaries rather than conversations because a listing is what this is for. A caller that
 * needs what was said asks for one conversation by id, instead of every transcript on disk
 * being read to draw a picker.
 *
 * A log that cannot be read (one written by a newer Jazz) is left out and logged, so one bad
 * file never empties the whole list.
 */
export function loadHistory(
  agentId: string,
  dir?: string,
): Effect.Effect<AgentConversationHistory, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const logs = yield* listConversationLogs(agentId, dir);
    const conversations: ConversationSummary[] = [];
    for (const log of logs) {
      const conversation = yield* readConversationLog(log.agentId, log.conversationId, dir).pipe(
        Effect.catchAll((error) =>
          logHousekeeping("warn", "Conversation left out of history: its log cannot be read", {
            conversationId: log.conversationId,
            error: error.message,
          }).pipe(Effect.as(null)),
        ),
      );
      if (conversation) conversations.push(summarize(conversation));
    }
    conversations.sort((left, right) => lastActivityMs(right) - lastActivityMs(left));
    return { agentId, conversations };
  });
}

function lastActivityMs(conversation: ConversationSummary): number {
  return Date.parse(conversation.lastMessageAt ?? conversation.startedAt);
}

/** One conversation with everything said in it, or null when there is no log for it. */
export function loadConversation(
  agentId: string,
  conversationId: string,
  dir?: string,
): Effect.Effect<Conversation | null, Error, FileSystem.FileSystem> {
  return readConversationLog(agentId, conversationId, dir);
}

/**
 * One conversation, or null when there is no log for it or the log cannot be read. For a
 * caller about to run a turn: the run is still valid without its past, so an unreadable log
 * degrades the turn instead of refusing it.
 */
export function loadConversationOrNull(
  agentId: string,
  conversationId: string,
  dir?: string,
): Effect.Effect<Conversation | null, never, FileSystem.FileSystem> {
  return loadConversation(agentId, conversationId, dir).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

/** Longest title a run names a new conversation with. */
const MAX_RUN_TITLE_CHARS = 80;

/**
 * Save a transcript a writer built on `conversation.basedOn`, or, when the conversation was
 * saved elsewhere since, save it as a new conversation instead of replacing what was said
 * there. Succeeds with the id the transcript was saved under.
 */
export function saveConversationOrFork(
  conversation: ConversationToSave,
  dir?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> {
  return saveConversation(conversation, dir).pipe(
    Effect.as(conversation.conversationId),
    Effect.catchIf(
      (error) => error instanceof ConversationChangedError,
      () => {
        const forkedId = generateConversationId();
        return saveConversation(
          {
            ...conversation,
            conversationId: forkedId,
            startedAt: new Date().toISOString(),
            basedOn: EMPTY_CONVERSATION_REVISION,
          },
          dir,
        ).pipe(Effect.as(forkedId));
      },
    ),
  );
}

/**
 * Save the transcript a run produced into its conversation. `prior` is the conversation as it
 * was loaded for the run: its title and start time are kept, a new conversation is named with
 * `fallbackTitle`, and the save builds on `prior`'s messages (see `saveConversationOrFork`).
 * Succeeds with the id the transcript was saved under.
 */
export function saveRunTranscript(
  options: {
    readonly agentId: string;
    readonly conversationId: string;
    readonly prior: Conversation | null;
    readonly fallbackTitle: string;
    readonly messages: readonly ChatMessage[];
  },
  dir?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> {
  return saveConversationOrFork(
    {
      agentId: options.agentId,
      conversationId: options.conversationId,
      title:
        options.prior?.title ??
        Array.from(options.fallbackTitle).slice(0, MAX_RUN_TITLE_CHARS).join(""),
      startedAt: options.prior?.startedAt ?? new Date().toISOString(),
      messages: [...options.messages],
      basedOn: conversationRevision(options.prior?.messages ?? []),
    },
    dir,
  );
}
