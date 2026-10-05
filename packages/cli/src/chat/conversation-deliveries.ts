/**
 * Work that comes back to the conversation a chat has open — a finished job batch, a due wake
 * trigger — run as a turn in that chat. Without this, the daemon or a detached worker resumed the
 * conversation as an unattended turn: it parked on the first approval, nobody in the chat saw
 * it, and the chat never moved.
 *
 * The chat attaches to its conversation (see `chat-attachments.ts`), which stops every other
 * process from claiming these items; the chat claims them itself when it is idle. When the chat
 * leaves the conversation it detaches and hands whatever is still owed to a detached process, so
 * the item is delivered unattended exactly as it would have been with no chat open.
 */
import { FileSystem } from "@effect/platform";
import { attachChat, detachChat } from "@jazz/adapters/chat-attachments";
import {
  claimBatchFanIn,
  listUndeliveredConversationBatches,
} from "@jazz/adapters/job-queue-service";
import {
  claimWakeTrigger,
  listDueConversationWakeTriggers,
  settleWakeTrigger,
} from "@jazz/adapters/wake-trigger-service";
import { toolKnownSecrets } from "@jazz/core/agent/tools/tool-secrets";
import { spawnDetachedJazz, spawnJobWorker } from "@jazz/core/jobs/spawn-job-worker";
import type { RunOrigin } from "@jazz/core/spend/sources";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { wakeTriggerFireArgs } from "@jazz/core/wake-triggers/wake-trigger-os-scheduler";
import { finishBatchFanIn, jobBatchDirectory, summarizeBatch } from "@jazz/daemon/job-worker";
import { wakeTriggerDirectory, wakeTriggerTurnPrompt } from "@jazz/daemon/trigger-runner";
import { Duration, Effect } from "effect";

/** A claimed item, ready to run as the chat's next turn and to be settled with how it ended. */
export interface ConversationDelivery {
  /** One line for the transcript, saying what came back. */
  readonly announcement: string;
  readonly prompt: string;
  readonly origin: RunOrigin;
  readonly settle: (outcome: DeliveryOutcome) => Effect.Effect<void, never, FileSystem.FileSystem>;
}

export function attachConversation(agentId: string, conversationId: string): Effect.Effect<void> {
  return Effect.sync(() => attachChat(agentId, conversationId));
}

/**
 * Leave the conversation, and start a detached process for each item still owed to it: a job
 * worker delivers a batch's fan-in once its jobs are done, and a wake trigger is fired.
 */
export function detachConversation(agentId: string, conversationId: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => detachChat(agentId, conversationId));
    const batches = yield* listUndeliveredConversationBatches(
      jobBatchDirectory(),
      agentId,
      conversationId,
    );
    if (batches.length > 0) {
      yield* spawnJobWorker(agentId);
    }
    const triggers = yield* listDueConversationWakeTriggers(
      wakeTriggerDirectory(),
      agentId,
      conversationId,
    );
    for (const trigger of triggers) {
      yield* spawnDetachedJazz(wakeTriggerFireArgs(agentId, trigger.id));
    }
  });
}

function hasOwedDelivery(agentId: string, conversationId: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const batches = yield* listUndeliveredConversationBatches(
      jobBatchDirectory(),
      agentId,
      conversationId,
    );
    if (batches.length > 0) {
      return true;
    }
    const triggers = yield* listDueConversationWakeTriggers(
      wakeTriggerDirectory(),
      agentId,
      conversationId,
    );
    return triggers.length > 0;
  });
}

/**
 * Resolves once something is owed to the conversation. It only looks, never claims, so it is
 * safe to race against the user's prompt: losing the race leaves nothing claimed. After a claim
 * came back empty it waits one interval before looking, so an item it sees but cannot take does
 * not spin the loop.
 */
export function awaitOwedDelivery(
  agentId: string,
  conversationId: string,
  pollIntervalMs: number,
  options: { readonly waitFirst: boolean },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (options.waitFirst) {
      yield* Effect.sleep(Duration.millis(pollIntervalMs));
    }
    while (!(yield* hasOwedDelivery(agentId, conversationId))) {
      yield* Effect.sleep(Duration.millis(pollIntervalMs));
    }
  });
}

/**
 * Claim the next item owed to the conversation, oldest first: finished batches, then due wake
 * triggers. Undefined when nothing is owed or another process claimed it first.
 */
export function claimOwedDelivery(
  agentId: string,
  conversationId: string,
): Effect.Effect<ConversationDelivery | undefined> {
  return Effect.gen(function* () {
    const batches = yield* listUndeliveredConversationBatches(
      jobBatchDirectory(),
      agentId,
      conversationId,
    );
    for (const candidate of batches) {
      const batch = yield* claimBatchFanIn(jobBatchDirectory(), agentId, candidate.id).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (batch === null) {
        continue;
      }
      const known = yield* toolKnownSecrets();
      return {
        announcement: `Background wait finished: ${batch.reason}`,
        prompt: summarizeBatch(batch, known),
        origin: { source: "job", name: batch.id },
        settle: (outcome) => finishBatchFanIn(agentId, batch.id, outcome).pipe(Effect.ignore),
      } satisfies ConversationDelivery;
    }

    const triggers = yield* listDueConversationWakeTriggers(
      wakeTriggerDirectory(),
      agentId,
      conversationId,
    );
    for (const candidate of triggers) {
      const trigger = yield* claimWakeTrigger(wakeTriggerDirectory(), agentId, candidate.id).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (trigger === undefined) {
        continue;
      }
      return {
        announcement: `Wake trigger fired: ${trigger.reason}`,
        prompt: wakeTriggerTurnPrompt(trigger, Date.now()),
        origin: { source: "wake-trigger", name: trigger.id },
        settle: (outcome) =>
          settleWakeTrigger(wakeTriggerDirectory(), agentId, trigger.id, outcome).pipe(
            Effect.ignore,
          ),
      } satisfies ConversationDelivery;
    }
    return undefined;
  });
}

/**
 * How a delivery turn in the chat counts. The user watched it, so it is delivered even when it
 * failed partway, as long as the turn kept its work; a turn that failed before keeping anything
 * lost the report and is retried.
 */
export function chatDeliveryOutcome(turn: {
  readonly errored: boolean;
  readonly keptWork: boolean;
}): DeliveryOutcome {
  if (turn.errored && !turn.keptWork) {
    return {
      delivered: false,
      error: "The chat turn that took this delivery failed before it kept any work.",
      retryable: true,
    };
  }
  return { delivered: true };
}
