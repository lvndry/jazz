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
import { ConversationNamingError, nameConversation } from "@jazz/core/agent/conversation-title";
import type { CallSpend } from "@jazz/core/agent/run/run-spend";
import type { LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { spawnDetachedJazz } from "@jazz/core/jobs/spawn-job-worker";
import { isSpendRecordedByParent } from "@jazz/core/spend/caps";
import { recordSpend } from "@jazz/core/spend/ledger";
import type { Agent } from "@jazz/core/types/agent";
import { Effect, type FileSystem } from "effect";

/**
 * Whether the turn that just finished may start naming its conversation: a saved conversation's
 * successful turn, when the namer has not started for it this session. The chat also needs an
 * answered exchange to name it from (`formatExchangeForNamer`), checked after these because it
 * reads the history; whether the conversation already has a title is decided from its saved log
 * by {@link nameSavedConversation}.
 */
export function shouldNameConversation(input: {
  readonly ephemeral: boolean;
  readonly turnErrored: boolean;
  readonly conversationId: string;
  readonly namerStartedFor: ReadonlySet<string>;
}): boolean {
  return !input.ephemeral && !input.turnErrored && !input.namerStartedFor.has(input.conversationId);
}

/**
 * What naming a saved conversation did. `skipped` made no model call: the conversation is not
 * saved yet (a later save can retry) or it already has a better name: one a person gave, one the
 * namer wrote, or a compaction checkpoint's.
 * `asked` called the model; `title` is undefined when the reply held no usable title or a person
 * named the conversation first.
 */
export type SavedConversationNaming =
  | { readonly kind: "skipped"; readonly reason: "not-saved" | "already-named" }
  | { readonly kind: "asked"; readonly title: string | undefined; readonly spend: CallSpend };

/**
 * Name a saved conversation from its first answered exchange and record the title as Jazz's own.
 * The call's cost goes to the spend ledger as attended chat spend: `jazz spend` shows it, and like
 * other chat spend it does not count against the daemon's unattended spend caps.
 * Reads the conversation once and skips the model call when it already has a better name (a
 * person's, the namer's, or a compaction checkpoint's), so a namer handed off at exit never pays
 * twice. A conversation saved before naming existed is named the first time it is continued.
 */
export function nameSavedConversation(
  agent: Agent,
  conversationId: string,
): Effect.Effect<
  SavedConversationNaming,
  Error,
  FileSystem.FileSystem | LLMService | LoggerService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const conversation = yield* loadConversationOrNull(agent.id, conversationId);
    if (conversation === null) {
      yield* logger.debug("Conversation title namer skipped: not saved yet", { conversationId });
      return { kind: "skipped", reason: "not-saved" } as const;
    }
    if (
      conversation.titleSource === "user" ||
      conversation.titleGenerated === true ||
      conversation.messages.some((message) => message.kind === "summary")
    ) {
      yield* logger.debug("Conversation title namer skipped: already named", { conversationId });
      return { kind: "skipped", reason: "already-named" } as const;
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
      return { kind: "asked", title: undefined, spend: naming.spend } as const;
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
      return { kind: "asked", title: undefined, spend: naming.spend } as const;
    }
    yield* logger.info("Named conversation", { conversationId });
    return { kind: "asked", title, spend: naming.spend } as const;
  });
}

/** Why naming failed, as a category safe to log: never a provider's error text. */
export function namingFailureReason(error: Error): string {
  return error instanceof ConversationNamingError ? error.reason : "storage";
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
