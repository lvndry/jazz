/**
 * `jazz agent chat <agent> --continue [--conversation <id>]`: open a chat on a
 * saved conversation instead of a fresh one.
 *
 * `continuedSessionOptions` resolves the conversation (the agent's most recent
 * one, or the id given) and returns the history and transcript to start the
 * chat with, the same pieces the home menu's "Resume" hands to the chat.
 */

import type { FileSystem } from "@effect/platform";
import { loadConversationOrNull } from "@jazz/adapters/history/conversation-history-service";
import { listConversationLogs } from "@jazz/adapters/history/conversation-log";
import type { Agent } from "@jazz/core/types";
import { ValidationError } from "@jazz/core/types/errors";
import type { ChatMessage } from "@jazz/core/types/message";
import { Effect } from "effect";

export interface ContinueOptions {
  /** Continue a saved conversation. */
  readonly continue?: boolean;
  /** Which conversation; the agent's most recent one when omitted. */
  readonly conversation?: string;
}

export interface ContinuedSession {
  readonly initialHistory?: ChatMessage[];
  readonly initialUiTranscript?: NonNullable<
    Effect.Effect.Success<ReturnType<typeof loadConversationOrNull>>
  >["uiTranscript"];
}

/**
 * The history to start the chat with, or nothing for a fresh chat. Fails when
 * `--conversation` is passed without `--continue`, when the agent has no saved
 * conversation, or when the named one cannot be read. `historyDirectory`
 * overrides where conversations are read from, for tests.
 */
export function continuedSessionOptions(
  agent: Agent,
  options: ContinueOptions | undefined,
  historyDirectory?: string,
): Effect.Effect<ContinuedSession, ValidationError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (options?.continue !== true) {
      if (options?.conversation !== undefined) {
        return yield* Effect.fail(
          new ValidationError({
            field: "--conversation",
            message: "--conversation picks which conversation --continue opens.",
            suggestion: `Add --continue: jazz agent chat ${agent.id} --continue --conversation ${options.conversation}`,
          }),
        );
      }
      return {};
    }

    const conversationId =
      options.conversation ??
      (yield* listConversationLogs(agent.id, historyDirectory).pipe(
        Effect.map((logs) => logs[0]?.conversationId),
        Effect.catchAll(() => Effect.succeed(undefined)),
      ));
    if (conversationId === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          field: "--continue",
          message: `${agent.name} has no saved conversation to continue.`,
          suggestion: `Start one with: jazz agent chat ${agent.id}`,
        }),
      );
    }

    const conversation = yield* loadConversationOrNull(agent.id, conversationId, historyDirectory);
    if (conversation === null) {
      return yield* Effect.fail(
        new ValidationError({
          field: "--conversation",
          message: `${agent.name} has no readable conversation "${conversationId}".`,
          suggestion: `Pick one from the home menu's Resume, or run: jazz agent chat ${agent.id} --continue`,
        }),
      );
    }
    return {
      initialHistory: [...conversation.messages],
      ...(conversation.uiTranscript !== undefined
        ? { initialUiTranscript: conversation.uiTranscript }
        : {}),
    };
  });
}
