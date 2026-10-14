/**
 * Deleting a conversation: its log, its archived copy, and everything Jazz kept for it.
 *
 * A conversation still in use is refused rather than deleted. Goals, loops, runs, wake triggers
 * and job batches load their conversation before each turn; a missing log loads as empty and the
 * next save writes it again, so deleting one of theirs would quietly bring it back with no
 * history. The same goes for a chat that has it open, a turn under way, and a conversation
 * handed off to another machine.
 *
 * Finished goals, loops and runs keep naming their conversation forever; they never come back to
 * it, so they do not hold it.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { clearWorkState } from "@jazz/core/agent/context/work-journal";
import { assertConversationWritable } from "@jazz/core/agent/detach/ownership";
import { isTerminalGoal } from "@jazz/core/agent/goal/goal-state";
import { isTerminalLoop } from "@jazz/core/agent/loop/loop-record";
import { browserScreenshotDirectory } from "@jazz/core/agent/tools/browser/browser-tools";
import { computerCapturesDirectory } from "@jazz/core/agent/tools/computer/grants";
import { getTodoFilePath } from "@jazz/core/agent/tools/todo";
import { toError } from "@jazz/core/utils/errors";
import { conversationLogGroup } from "@jazz/core/utils/log-group";
import { withLock } from "@jazz/core/utils/storage";
import { Effect } from "effect";
import { forgetChatAttachment, heldByChatElsewhere } from "../chat-attachments";
import { ConversationBusyError, withConversationTurn } from "./conversation-lease";
import {
  agentConversationLockPath,
  archivedConversationLogPath,
  deleteConversationLog,
} from "./conversation-log";
import { JobQueueServiceImpl, listUndeliveredConversationBatches } from "../job-queue-service";
import { getLogsDirectory } from "../logger";
import { FileGoalStore } from "../storage/goal-store";
import { FileLoopStore } from "../storage/loop-store";
import { FileRunStore } from "../storage/run-store";
import { WakeTriggerServiceImpl } from "../wake-trigger-service";

/** A conversation that cannot be deleted right now; the message says why, for a person. */
export class ConversationInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationInUseError";
  }
}

/** Why something still needs the conversation, or undefined when nothing does. */
function conversationUse(
  agentId: string,
  conversationId: string,
): Effect.Effect<string | undefined, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const handedOff = yield* Effect.tryPromise({
      try: () => assertConversationWritable(agentId, conversationId),
      catch: toError,
    }).pipe(
      Effect.as(false),
      Effect.catchAll(() => Effect.succeed(true)),
    );
    if (handedOff) {
      return "It is running on another machine. Bring it back with /detach first.";
    }
    if (heldByChatElsewhere(agentId, conversationId)) {
      return "It is open in another Jazz chat. Close that chat first.";
    }

    const names = (record: { conversationId: string; sourceConversationId?: string }): boolean =>
      record.conversationId === conversationId || record.sourceConversationId === conversationId;
    const goals = yield* new FileGoalStore().list({ agentId });
    if (goals.some((goal) => names(goal) && !isTerminalGoal(goal.state))) {
      return "A goal is still working in it. Cancel the goal first.";
    }
    const loops = yield* new FileLoopStore().list({ agentId });
    if (loops.some((loop) => names(loop) && !isTerminalLoop(loop.state))) {
      return "A loop is still running in it. Stop the loop first.";
    }
    const runs = yield* new FileRunStore().list({ agentId });
    if (runs.some((run) => run.conversationId === conversationId)) {
      return "A run in it is still waiting to finish. Cancel or finish it first.";
    }

    const triggers = yield* new WakeTriggerServiceImpl().list(agentId);
    if (triggers.some((trigger) => trigger.conversationId === conversationId)) {
      return "A wake-up is scheduled for it. Cancel it with `jazz triggers` first.";
    }
    const jobQueue = new JobQueueServiceImpl();
    const activeBatches = yield* jobQueue.listActiveBatches(agentId);
    const undelivered = yield* listUndeliveredConversationBatches(
      jobQueue.baseJobBatchDirectory,
      agentId,
      conversationId,
    );
    if (
      undelivered.length > 0 ||
      activeBatches.some((batch) => batch.conversationId === conversationId)
    ) {
      return "Background work is still reporting back to it. Cancel it with `jazz jobs` first.";
    }
    return undefined;
  });
}

/** Every log file written for the conversation: its own and its rotations, under both names. */
async function removeLogFiles(agentId: string, conversationId: string): Promise<void> {
  const directory = getLogsDirectory();
  const bases = new Set([
    conversationLogGroup(agentId, conversationId),
    conversationId.replace(/[^a-zA-Z0-9_-]/g, "_"),
  ]);
  const names = await nodeFs.readdir(directory).catch(() => [] as string[]);
  const rotation = /^\.\d+$/;
  await Promise.all(
    names
      .filter((name) =>
        [...bases].some((base) => {
          if (!name.startsWith(`${base}.log`)) {
            return false;
          }
          const suffix = name.slice(`${base}.log`.length);
          return suffix === "" || rotation.test(suffix);
        }),
      )
      .map((name) => nodeFs.rm(path.join(directory, name), { force: true })),
  );
}

async function removeKeptFiles(agentId: string, conversationId: string): Promise<void> {
  await Promise.all([
    nodeFs.rm(archivedConversationLogPath(agentId, conversationId), { force: true }),
    nodeFs.rm(getTodoFilePath(conversationId), { force: true }),
    nodeFs.rm(browserScreenshotDirectory(conversationId), { recursive: true, force: true }),
    nodeFs.rm(computerCapturesDirectory(conversationId), { recursive: true, force: true }),
    removeLogFiles(agentId, conversationId),
  ]);
  forgetChatAttachment(agentId, conversationId);
}

/**
 * Delete one conversation and what Jazz kept for it, or fail with
 * {@link ConversationInUseError} when something still needs it. Holds the conversation's turn
 * lease and the agent's save lock while it deletes, so no turn or save lands in between.
 */
export function deleteConversation(
  agentId: string,
  conversationId: string,
): Effect.Effect<void, ConversationInUseError | Error, FileSystem.FileSystem> {
  const deleteUnderLocks = Effect.gen(function* () {
    const use = yield* conversationUse(agentId, conversationId);
    if (use !== undefined) {
      return yield* Effect.fail(new ConversationInUseError(use));
    }
    yield* withLock(
      agentConversationLockPath(agentId),
      deleteConversationLog(agentId, conversationId),
    );
    yield* clearWorkState(agentId, conversationId);
    yield* Effect.tryPromise({
      try: () => removeKeptFiles(agentId, conversationId),
      catch: toError,
    });
  });
  return withConversationTurn(agentId, conversationId, deleteUnderLocks, { maxWaitMs: 0 }).pipe(
    Effect.catchIf(
      (error): error is ConversationBusyError => error instanceof ConversationBusyError,
      () =>
        Effect.fail(
          new ConversationInUseError("A turn is running in it right now. Try again when it ends."),
        ),
    ),
  );
}
