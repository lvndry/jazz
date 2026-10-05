/**
 * One turn at a time on a conversation, across every process that runs one: the chat, an
 * unattended delivery, a goal cycle, a loop run, a webhook, `jazz run --conversation`.
 *
 * A turn loads the conversation, runs, and saves what it produced. Two turns doing that at once
 * build on the same history, and the second save forks into a new conversation. Holding this
 * lease from the load to the save makes the second turn wait and then build on the first one's
 * result instead, so the conversation stays one conversation.
 *
 * The lease is the shared cross-process lock (`file-lock.ts`): a holder that died is reclaimed,
 * a live one never is. Waiting retries one quick attempt at a time with an interruptible sleep in
 * between, so Ctrl+C stops a waiting turn without leaving a lock behind.
 */
import { acquireFileLock } from "@jazz/core/utils/file-lock";
import { Duration, Effect, type Scope } from "effect";
import { conversationTurnLockPath } from "./conversation-log";

/** Pause between attempts while another turn holds the conversation. */
const LEASE_RETRY_MS = 500;

/** A turn found the conversation held by another for longer than it was willing to wait. */
export class ConversationBusyError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, waitedMs: number) {
    super(
      `Conversation ${conversationId} stayed busy in another session for ${String(Math.round(waitedMs / 1000))}s`,
    );
    this.name = "ConversationBusyError";
    this.conversationId = conversationId;
  }
}

class LeaseHeld extends Error {}

export interface ConversationTurnOptions {
  /** Runs once, when the first attempt finds another turn holding the conversation. */
  readonly onBusy?: Effect.Effect<void>;
  /** Give up after this long; waits as long as it takes when absent. */
  readonly maxWaitMs?: number;
  readonly historyDirectory?: string;
}

/**
 * Hold the conversation's lease until the scope closes, waiting for any other turn on it to end
 * first. For a turn that is not one effect, such as a whole `jazz run` command.
 */
export function holdConversationTurn(
  agentId: string,
  conversationId: string,
  options: ConversationTurnOptions = {},
): Effect.Effect<void, ConversationBusyError, Scope.Scope> {
  const lockPath = conversationTurnLockPath(agentId, conversationId, options.historyDirectory);
  // One attempt, never a wait: the acquisition is uninterruptible, so the waiting happens in
  // the sleep between attempts, where an interrupt can land without stranding a lock.
  const attempt = Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireFileLock(lockPath, { maxWaitMs: 0, timeoutError: () => new LeaseHeld() }),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        error instanceof LeaseHeld ? Effect.succeed(null) : Effect.die(error),
      ),
    ),
    (release) => (release === null ? Effect.void : Effect.promise(() => release())),
  );
  return Effect.gen(function* () {
    const startedAt = Date.now();
    let announced = false;
    for (;;) {
      if ((yield* attempt) !== null) {
        return;
      }
      const waitedMs = Date.now() - startedAt;
      if (options.maxWaitMs !== undefined && waitedMs >= options.maxWaitMs) {
        return yield* Effect.fail(new ConversationBusyError(conversationId, waitedMs));
      }
      if (!announced) {
        announced = true;
        if (options.onBusy !== undefined) {
          yield* options.onBusy;
        }
      }
      yield* Effect.sleep(Duration.millis(LEASE_RETRY_MS));
    }
  });
}

/** Run `turn` holding the conversation's lease, waiting for any other turn on it to end first. */
export function withConversationTurn<A, E, R>(
  agentId: string,
  conversationId: string,
  turn: Effect.Effect<A, E, R>,
  options: ConversationTurnOptions = {},
): Effect.Effect<A, E | ConversationBusyError, Exclude<R, Scope.Scope>> {
  return Effect.scoped(
    Effect.zipRight(holdConversationTurn(agentId, conversationId, options), turn),
  );
}
