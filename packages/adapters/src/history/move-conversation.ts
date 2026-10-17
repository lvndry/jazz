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
import { Effect } from "effect";
import { ConversationBusyError, withConversationTurn } from "./conversation-lease";
import { agentConversationLockPath, moveConversationLog } from "./conversation-log";
import { ConversationInUseError, conversationUse } from "./delete-conversation";

async function moveWorkState(
  fromAgentId: string,
  toAgentId: string,
  conversationId: string,
): Promise<void> {
  const source = getWorkStateDirectory(fromAgentId, conversationId);
  const destination = getWorkStateDirectory(toAgentId, conversationId);
  const exists = await nodeFs.stat(source).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return;
  }
  await nodeFs.rm(destination, { recursive: true, force: true });
  await nodeFs.mkdir(path.dirname(destination), { recursive: true });
  await nodeFs.rename(source, destination);
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
    const moved = yield* withLock(
      firstLock,
      withLock(secondLock, moveConversationLog(fromAgentId, toAgentId, conversationId)),
    );
    yield* Effect.tryPromise({
      try: () => moveWorkState(fromAgentId, toAgentId, conversationId),
      catch: toError,
    });
    return moved;
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
