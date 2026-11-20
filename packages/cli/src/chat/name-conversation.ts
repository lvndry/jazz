/**
 * Names a new conversation after its first answer. The chat runs the namer in the background so
 * the title shows while it is open; a namer still running when the chat closes is handed to a
 * detached `jazz agent name-conversation`, so leaving never waits and the title still lands.
 */

import {
  loadConversationOrNull,
  saveGeneratedConversationTitle,
} from "@jazz/adapters/history/conversation-history-service";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { nameConversation } from "@jazz/core/agent/conversation-title";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { spawnDetachedJazz } from "@jazz/core/jobs/spawn-job-worker";
import { isSpendRecordedByParent } from "@jazz/core/spend/caps";
import { recordSpend } from "@jazz/core/spend/ledger";
import type { Agent } from "@jazz/core/types/agent";
import { Effect } from "effect";

/**
 * Whether the turn that just finished should start naming its conversation: a saved
 * conversation's first successful turn that leaves a written answer to name it from, while it
 * has no title and the namer has not already started for it this session.
 */
export function shouldNameConversation(input: {
  readonly ephemeral: boolean;
  readonly turnErrored: boolean;
  readonly hasAnsweredExchange: boolean;
  readonly conversationTitle: string | undefined;
  readonly conversationId: string;
  readonly namerStartedFor: string | undefined;
}): boolean {
  return (
    !input.ephemeral &&
    !input.turnErrored &&
    input.hasAnsweredExchange &&
    input.conversationTitle === undefined &&
    input.namerStartedFor !== input.conversationId
  );
}

/**
 * Name a saved conversation from its first answered exchange and record the title as Jazz's own.
 * The call's cost goes to the spend ledger as chat spend, so spend caps and `jazz spend` count it.
 * Succeeds with the title written, or undefined when the conversation is not saved, a person
 * already named it, or the reply held no usable title.
 */
export function nameSavedConversation(agent: Agent, conversationId: string) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const conversation = yield* loadConversationOrNull(agent.id, conversationId);
    if (conversation === null) {
      yield* logger.debug("Conversation title namer skipped: conversation not saved", {
        conversationId,
      });
      return undefined;
    }
    if (conversation.titleSource === "user") {
      yield* logger.debug("Conversation title namer skipped: named by a person", {
        conversationId,
      });
      return undefined;
    }
    const naming = yield* nameConversation(agent, conversation.messages);
    if (!isSpendRecordedByParent()) {
      yield* recordSpend({
        agentId: agent.id,
        source: "chat",
        costUSD: naming.spend.costUSD ?? 0,
        costKnown: naming.spend.costKnown,
        tokens: naming.spend.totalTokens,
        unattended: false,
      }).pipe(
        Effect.catch((error) =>
          logger.warn("Could not record the conversation title namer's spend", {
            conversationId,
            error: error.message,
          }),
        ),
      );
    }
    const title = naming.title;
    if (title === undefined) {
      yield* logger.debug("Conversation title namer replied with no usable title", {
        conversationId,
      });
      return undefined;
    }
    const recorded = yield* saveGeneratedConversationTitle({
      agentId: agent.id,
      conversationId,
      title,
    });
    if (!recorded) {
      yield* logger.debug("Conversation named by a person first; kept their title", {
        conversationId,
      });
      return undefined;
    }
    yield* logger.info("Named conversation", { conversationId });
    return title;
  });
}

/** `jazz agent name-conversation`: the detached hand-off of {@link nameSavedConversation}. */
export function nameConversationCommand(options: {
  readonly agent: string;
  readonly conversation: string;
}) {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(options.agent);
    yield* nameSavedConversation(agent, options.conversation);
  });
}

/**
 * A launch failure is logged rather than shown: the chat is closing, and the conversation keeps
 * its first message as its title, which is what it had before.
 */
export function nameConversationInDetachedProcess(
  agentId: string,
  conversationId: string,
  configPath?: string,
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const launch = yield* spawnDetachedJazz([
      ...(configPath === undefined ? [] : ["--config", configPath]),
      "--output",
      "quiet",
      "agent",
      "name-conversation",
      "--agent",
      agentId,
      "--conversation",
      conversationId,
    ]);
    if (!launch.spawned) {
      yield* logger.warn("Could not hand the conversation title namer to a detached process", {
        agentId,
        conversationId,
        reason: launch.reason,
      });
      return;
    }
    yield* logger.debug("Handed the conversation title namer to a detached process", {
      agentId,
      conversationId,
    });
  });
}
