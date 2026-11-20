/**
 * Names a new conversation after its first answer, in a detached `jazz agent name-conversation`,
 * so the chat never waits on the namer and the title still lands when the chat closes first.
 */

import {
  loadConversationOrNull,
  saveGeneratedConversationTitle,
} from "@jazz/adapters/history/conversation-history-service";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { nameConversation } from "@jazz/core/agent/conversation-title";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { spawnDetachedJazz } from "@jazz/core/jobs/spawn-job-worker";
import { Effect } from "effect";

/**
 * A launch failure is logged rather than shown: the conversation keeps its first message as its
 * title, which is what it had before.
 */
export function nameConversationInBackground(
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
      yield* logger.warn("Could not start the conversation title namer", {
        agentId,
        conversationId,
        reason: launch.reason,
      });
      return;
    }
    yield* logger.debug("Started the conversation title namer", { agentId, conversationId });
  });
}

/**
 * Name a saved conversation from its first answered exchange and record the title as Jazz's own.
 * A conversation a person already named keeps its title.
 */
export function nameConversationCommand(options: {
  readonly agent: string;
  readonly conversation: string;
}) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const agent = yield* getAgentByIdentifier(options.agent);
    const conversation = yield* loadConversationOrNull(agent.id, options.conversation);
    if (conversation === null) {
      yield* logger.debug("Conversation title namer skipped: conversation not saved", {
        conversationId: options.conversation,
      });
      return;
    }
    if (conversation.titleSource === "user") {
      yield* logger.debug("Conversation title namer skipped: named by a person", {
        conversationId: conversation.conversationId,
      });
      return;
    }
    const title = yield* nameConversation(agent, conversation.messages);
    const recorded = yield* saveGeneratedConversationTitle({
      agentId: agent.id,
      conversationId: conversation.conversationId,
      title,
    });
    yield* logger.info(recorded ? "Named conversation" : "Conversation named by a person first", {
      conversationId: conversation.conversationId,
      title,
    });
  });
}
