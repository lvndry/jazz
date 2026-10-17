/**
 * Handing a conversation to another agent, so switching agents mid-chat continues the same
 * conversation instead of leaving one copy under each agent. The log and the work state move;
 * resuming then picks the conversation up with the agent it last moved to.
 *
 * A conversation something still needs under its current agent (a goal, loop, run, wake
 * trigger, job batch, another chat, a turn under way) is refused, as for deletion: those
 * records name the agent and would lose the conversation if it moved.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError } from "@jazz/core/utils/errors";
import { getWorkStateDirectory } from "@jazz/core/utils/paths";
import { withLock } from "@jazz/core/utils/storage";
import { storageSafeSegment } from "@jazz/core/utils/storage-id";
import { Effect } from "effect";
import { ConversationBusyError, withConversationTurn } from "./conversation-lease";
import {
  agentConversationLockPath,
  archiveConversationLog,
  deleteConversationLog,
  getHistoryArchiveDirectory,
  moveConversationLog,
} from "./conversation-log";
import { ConversationInUseError, conversationUse } from "./delete-conversation";

/** Where a conversation's work state is kept once a newer copy replaces it, beside its archived log. */
export function archivedWorkStateDirectory(agentId: string, conversationId: string): string {
  return path.join(
    getHistoryArchiveDirectory(),
    "work",
    storageSafeSegment(agentId),
    storageSafeSegment(conversationId),
  );
}

async function directoryExists(directory: string): Promise<boolean> {
  return nodeFs.stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** Renames `source` to `destination`, replacing whatever was there; false when `source` is absent. */
async function replaceDirectory(source: string, destination: string): Promise<boolean> {
  if (!(await directoryExists(source))) {
    return false;
  }
  await nodeFs.rm(destination, { recursive: true, force: true });
  await nodeFs.mkdir(path.dirname(destination), { recursive: true });
  await nodeFs.rename(source, destination);
  return true;
}

function tryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: run, catch: toError });
}

/**
 * Moves the log and work state under both agents' save locks. A copy the destination already
 * holds is archived first, its log and work state together. The work state moves before the
 * log, and the source log is the last thing removed, so when the log cannot move the work state
 * goes back and any half-written destination log is dropped: the conversation stays whole under
 * its current agent.
 */
function moveConversationFiles(
  fromAgentId: string,
  toAgentId: string,
  conversationId: string,
): Effect.Effect<boolean, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const sourceWork = getWorkStateDirectory(fromAgentId, conversationId);
    const destinationWork = getWorkStateDirectory(toAgentId, conversationId);

    yield* archiveConversationLog(toAgentId, conversationId);
    yield* tryPromise(() =>
      replaceDirectory(destinationWork, archivedWorkStateDirectory(toAgentId, conversationId)),
    );

    const workMoved = yield* tryPromise(() => replaceDirectory(sourceWork, destinationWork));
    return yield* moveConversationLog(fromAgentId, toAgentId, conversationId).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          yield* deleteConversationLog(toAgentId, conversationId);
          if (workMoved) {
            yield* tryPromise(() => replaceDirectory(destinationWork, sourceWork)).pipe(
              Effect.ignore,
            );
          }
        }),
      ),
    );
  });
}

/**
 * Move a conversation from one agent to another, or fail with {@link ConversationInUseError}
 * when something still needs it where it is. Holds both agents' turn leases and save locks
 * while it moves, so no turn or save lands in between. Succeeds with false when the
 * conversation has nothing saved yet.
 */
export function moveConversationToAgent(
  fromAgentId: string,
  toAgentId: string,
  conversationId: string,
): Effect.Effect<boolean, ConversationInUseError | Error, FileSystem.FileSystem> {
  if (fromAgentId === toAgentId) {
    return Effect.succeed(false);
  }
  const fromLock = agentConversationLockPath(fromAgentId);
  const toLock = agentConversationLockPath(toAgentId);
  // Same order for every mover, so two moves in opposite directions never deadlock.
  const [firstLock, secondLock] = fromLock < toLock ? [fromLock, toLock] : [toLock, fromLock];
  const moveUnderLocks = Effect.gen(function* () {
    for (const agentId of [fromAgentId, toAgentId]) {
      const use = yield* conversationUse(agentId, conversationId);
      if (use !== undefined) {
        return yield* Effect.fail(new ConversationInUseError(use));
      }
    }
    return yield* withLock(
      firstLock,
      withLock(secondLock, moveConversationFiles(fromAgentId, toAgentId, conversationId)),
    );
  });
  return withConversationTurn(
    fromAgentId,
    conversationId,
    withConversationTurn(toAgentId, conversationId, moveUnderLocks, { maxWaitMs: 0 }),
    { maxWaitMs: 0 },
  ).pipe(
    Effect.catchIf(
      (error): error is ConversationBusyError => error instanceof ConversationBusyError,
      () =>
        Effect.fail(
          new ConversationInUseError("A turn is running in it right now. Try again when it ends."),
        ),
    ),
  );
}
