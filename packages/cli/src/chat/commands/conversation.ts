/**
 * Conversation operations for the terminal chat command router. Call these handlers with
 * the active session context or history and apply their CommandResult in the chat loop:
 * /new creates a fresh ID, /fork branches the current history, /resume selects a saved
 * transcript, and /rename persists an explicit title before returning a session title update.
 *
 * These handlers do not call the model. History replacement and persistence remain explicit
 * result fields so the chat loop owns transcript repainting, saving the original conversation,
 * and session lifecycle. Formatting and storage use the existing shared services directly.
 */
import type { FileSystem } from "@effect/platform";
import {
  ConversationChangedError,
  conversationRevision,
  displayConversationTitle,
  loadConversation,
  moveConversationLeaf,
  readConversationBranches,
  loadConversationOrNull,
  loadHistory,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";
import { formatRelativeWhen } from "@jazz/adapters/history/conversation-search";
import { report, type TerminalService } from "@jazz/core/interfaces/terminal";
import { typedText } from "@jazz/core/memory/source-trust";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { Effect } from "effect";
import * as fmt from "@/cli/utils/list-format";
import type { CommandContext, CommandResult } from "./types";

/** Rename one conversation without model work; report storage failures before changing its title. */
export function handleRenameCommand(
  terminal: TerminalService,
  context: CommandContext,
  args: readonly string[],
): Effect.Effect<CommandResult, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const prior =
      context.ephemeral === true
        ? Effect.succeed(null)
        : loadConversation(context.agent.id, context.conversationId);
    const loaded = yield* Effect.either(prior);
    if (loaded._tag === "Left") {
      yield* terminal.error(`Could not rename conversation: ${loaded.left.message}`);
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const current = context.conversationTitle ?? loaded.right?.title ?? "";
    const entered =
      args.length > 0
        ? args[0]
        : yield* terminal.ask("Conversation title:", {
            defaultValue: current,
            simple: true,
            cancellable: true,
            validate: (input) => input.trim().length > 0 || "Enter a conversation title.",
          });
    if (entered === undefined) return { shouldContinue: true, skipTranscriptRepaint: true };
    const title = entered.trim();
    if (title.length === 0) {
      yield* terminal.error("Enter a conversation title.");
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    if (context.ephemeral !== true) {
      const saved = yield* Effect.either(
        saveConversation({
          agentId: context.agent.id,
          conversationId: context.conversationId,
          title,
          startedAt: loaded.right?.startedAt ?? context.sessionStartedAt.toISOString(),
          messages: [...context.conversationHistory],
          ...(loaded.right?.uiTranscript !== undefined
            ? { uiTranscript: loaded.right.uiTranscript }
            : {}),
          basedOn: context.conversationRevision,
        }),
      );
      if (saved._tag === "Left") {
        yield* terminal.error(`Could not rename conversation: ${saved.left.message}`);
        return { shouldContinue: true, skipTranscriptRepaint: true };
      }
      yield* terminal.success(`Renamed conversation: ${title}`);
      return {
        shouldContinue: true,
        newConversationTitle: title,
        conversationRevision: saved.right,
        skipTranscriptRepaint: true,
      };
    }
    yield* terminal.success(`Renamed conversation: ${title}`);
    return { shouldContinue: true, newConversationTitle: title, skipTranscriptRepaint: true };
  });
}

/**
 * Start a fresh conversation with the current agent and report unsupported model tools.
 */
export function handleStartCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.clear();
    yield* terminal.log(
      report("new", [
        { kind: "text", text: "A fresh conversation. The agent starts with no history." },
      ]),
    );

    const modelMeta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
    );
    if (
      modelMeta &&
      !modelMeta.supportsTools &&
      agent.config.tools &&
      agent.config.tools.length > 0
    ) {
      yield* terminal.warn(
        `${agent.config.llm.model} does not support tools, so this agent's tools are off for this model.`,
      );
    }

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.blank());
    return {
      shouldContinue: true,
      newConversationId: generateConversationId(),
      newHistory: [],
      saveCurrentHistory: true,
    };
  });
}

/**
 * Handle /fork command - Fork the conversation into a new branch
 *
 * Saves the current branch under its own conversation ID, then continues on a
 * new one carrying the full history forward. Future turns diverge from here
 * while the transcript stays on screen — forking branches the conversation
 * without discarding what came before.
 *
 * The transcript repaint is skipped: the same full history stays on screen, so
 * repainting would only clear the switch notice and redraw an identical view.
 */
export function handleForkCommand(
  terminal: TerminalService,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    if (conversationHistory.length === 0) {
      yield* terminal.warn("Cannot fork: no messages in history.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    yield* terminal.log(
      report(
        "fork",
        [
          {
            kind: "text",
            text: "You're on a new branch with the full history. The original is unchanged.",
          },
        ],
        "Return to the original with /resume.",
      ),
    );
    yield* terminal.log(fmt.blank());
    return {
      shouldContinue: true,
      newConversationId: generateConversationId(),
      newHistory: [...conversationHistory],
      saveCurrentHistory: true,
      skipTranscriptRepaint: true,
    };
  });
}

/**
 * `/tree`: continue the conversation from another of its branches, or rewind to just before an
 * earlier message of yours and put it back in the composer to edit. Branches are the
 * alternatives the log keeps (an answer `/retry` replaced, the turns an edit left behind).
 * Switching appends a `leaf` event; editing writes nothing until the edited message is sent,
 * when the save branches from where it was.
 */
export function handleTreeCommand(terminal: TerminalService, context: CommandContext) {
  return Effect.gen(function* () {
    if (context.ephemeral === true) {
      yield* terminal.info("This session is not saved, so it has no branches.");
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const agentId = context.agent.id;
    const branches = yield* readConversationBranches(agentId, context.conversationId).pipe(
      Effect.either,
    );
    if (branches._tag === "Left") {
      yield* terminal.error(`Could not read this conversation: ${branches.left.message}`);
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const nowMs = Date.now();
    const editable = context.conversationHistory.flatMap((message, index) =>
      message.role === "user" && message.entryId !== undefined ? [{ message, index }] : [],
    );
    const choices = [
      ...branches.right.map((branch) => ({
        name: `${branch.current ? "current · " : ""}${branch.label || "(empty)"}`,
        description: `${String(branch.messageCount)} messages${branch.lastAt === null ? "" : ` · ${formatRelativeWhen(Date.parse(branch.lastAt), nowMs)}`}`,
        value: `branch:${branch.tipId}`,
      })),
      ...editable.reverse().map(({ message, index }) => ({
        name: `edit · ${typedText(message).replace(/\s+/g, " ").trim().slice(0, 72)}`,
        description: "rewind to before this message and edit it",
        value: `edit:${String(index)}`,
      })),
    ];
    if (branches.right.length <= 1 && editable.length === 0) {
      yield* terminal.info("This conversation has no other branches yet.");
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const selection = yield* terminal.search<string>("Continue from which branch?", {
      choices,
      placeholder: "Type to filter",
    });
    if (selection === undefined || selection === null) {
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const separator = selection.indexOf(":");
    const action = selection.slice(0, separator);
    const target = selection.slice(separator + 1);

    if (action === "edit") {
      const index = Number(target);
      const message = context.conversationHistory[index];
      if (message === undefined) {
        return { shouldContinue: true, skipTranscriptRepaint: true };
      }
      yield* terminal.info(
        "Rewound to before that message. Edit it and send to branch from there.",
      );
      return {
        shouldContinue: true,
        newHistory: context.conversationHistory.slice(0, index),
        composerDraft: typedText(message),
      };
    }

    const branch = branches.right.find((candidate) => candidate.tipId === target);
    if (branch === undefined || branch.current) {
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    const moved = yield* moveConversationLeaf({
      agentId,
      conversationId: context.conversationId,
      to: branch.tipId,
      basedOn: context.conversationRevision,
    }).pipe(Effect.either);
    if (moved._tag === "Left") {
      yield* terminal.error(
        moved.left instanceof ConversationChangedError
          ? "This conversation was saved from somewhere else meanwhile; run /tree again."
          : `Could not switch branches: ${moved.left.message}`,
      );
      return { shouldContinue: true, skipTranscriptRepaint: true };
    }
    yield* terminal.success(`Continuing from: ${branch.label || "(empty)"}`);
    return {
      shouldContinue: true,
      newHistory: [
        ...context.conversationHistory.filter((message) => message.role === "system"),
        ...moved.right.messages,
      ],
      conversationRevision: conversationRevision(moved.right.messages),
    };
  });
}

/**
 * Select a saved transcript, reading its full log only after the user chooses it, and switch
 * the chat to that conversation so later turns append to its own log. Restored history carries
 * the resume notice; the runner rebuilds the live system prompt for each run.
 */
export function handleResumeCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const history = yield* loadHistory(agent.id).pipe(
      Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
    );

    if (history.conversations.length === 0) {
      yield* terminal.info("No past conversations found for this agent.");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const choices = history.conversations.map((conv) => {
      const date = new Date(conv.lastMessageAt ?? conv.startedAt);
      const dateStr = date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return {
        name: `${displayConversationTitle(conv.title)}  (${dateStr}, ${conv.messageCount} messages)`,
        value: conv.conversationId,
      };
    });

    const selectedId = yield* terminal.search<string>("Select a conversation to resume:", {
      choices,
      placeholder: "Type to filter conversations…",
    });

    if (!selectedId) {
      yield* terminal.log("Resume cancelled");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const selected = history.conversations.find((c) => c.conversationId === selectedId);
    if (!selected) {
      return { shouldContinue: true };
    }

    const conversation = yield* loadConversationOrNull(agent.id, selected.conversationId);
    if (!conversation) {
      yield* terminal.info("That conversation could no longer be read.");
      return { shouldContinue: true };
    }

    const resumeSystemMessage = {
      role: "system" as const,
      content: `Resuming conversation from ${new Date(selected.startedAt).toLocaleString()}: ${displayConversationTitle(selected.title)}`,
    };

    const newHistory = [resumeSystemMessage, ...conversation.messages];

    yield* terminal.success(`Resumed: ${displayConversationTitle(selected.title)}`);
    yield* terminal.log("");
    return {
      shouldContinue: true,
      newConversationId: selected.conversationId,
      conversationRevision: conversationRevision(conversation.messages),
      newHistory,
      ...(conversation.title === undefined ? {} : { newConversationTitle: conversation.title }),
      ...(conversation.uiTranscript !== undefined
        ? { newUiTranscript: conversation.uiTranscript }
        : {}),
      saveCurrentHistory: true,
    };
  });
}
