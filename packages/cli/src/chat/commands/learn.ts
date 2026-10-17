/**
 * @fileoverview The chat `/learn` command (alias `/reflect`): pause, learn from the conversation
 * so far, tidy memory with what this session added and removed in hand, and decide every
 * resulting change from one checklist. A pass that fails or is interrupted releases its claim on
 * the conversation, so the next pass reads those messages again.
 */

import { loadConversationOrNull } from "@jazz/adapters/history/conversation-history-service";
import {
  claimUnreflectedMessages,
  releaseReflectionClaim,
} from "@jazz/adapters/reflection-watermark";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { learnFromConversation } from "@jazz/core/agent/context/memory-extractor";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import { report, TerminalServiceTag, type ReportRow } from "@jazz/core/interfaces/terminal";
import {
  describeSessionMemoryChanges,
  diffMemoryStates,
  memoryStateFromSnapshot,
  type SessionMemoryChanges,
} from "@jazz/core/memory/session-changes";
import { suggestionDestinationPath } from "@jazz/core/memory/suggestion-destination";
import { getMemoryDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import type { CommandContext, CommandResult } from "./types";
import {
  reviewMemorySuggestions,
  suggestionHeadline,
  suggestionKindTag,
} from "../../memory-review";

/** Every memory entry's first line and content hash, to diff against when `/learn` runs. */
export function snapshotMemoryState() {
  return Effect.gen(function* () {
    const memoryService = yield* MemoryServiceTag;
    const snapshot = yield* memoryService.snapshotEntries();
    return memoryStateFromSnapshot(snapshot.entries);
  });
}

function sessionChangeRows(changes: SessionMemoryChanges): ReportRow[] {
  const groups: Array<[string, SessionMemoryChanges["added"]]> = [
    ["added", changes.added],
    ["changed", changes.changed],
    ["removed", changes.removed],
  ];
  const rows = groups.flatMap(([key, entries]) =>
    entries.map((entry): ReportRow => ({
      kind: "field",
      key,
      value: entry.path,
      detail: entry.summary,
    })),
  );
  return rows.length > 0
    ? [{ kind: "group", label: "this session", count: String(rows.length) }, ...rows]
    : [{ kind: "text", text: "Memory has not changed this session." }];
}

export function handleLearnCommand(context: CommandContext) {
  return Effect.gen(function* () {
    const { memoryAtSessionStart } = context;
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const result: CommandResult = { shouldContinue: true };

    if (context.ephemeral === true || memoryAtSessionStart === undefined) {
      yield* terminal.warn(
        "This conversation keeps nothing in memory, so there is nothing to learn.",
      );
      return result;
    }
    if (!context.conversationHistory.some((message) => message.role === "assistant")) {
      yield* terminal.info("Nothing to learn from yet: the agent has not answered.");
      return result;
    }

    const changes = diffMemoryStates(memoryAtSessionStart, yield* snapshotMemoryState());
    yield* terminal.log(report("memory", sessionChangeRows(changes)));

    const saved = yield* loadConversationOrNull(context.agent.id, context.conversationId);
    const messages = (saved?.messages ?? context.conversationHistory).filter(
      (message) => message.role !== "system",
    );
    const claim =
      saved === null
        ? undefined
        : yield* claimUnreflectedMessages(
            getMemoryDirectory(),
            context.agent.id,
            saved.conversationId,
            saved.messages,
          );
    const unreflected = claim?.messages ?? messages;
    const releaseClaim = Effect.suspend(() =>
      claim === undefined || saved === null
        ? Effect.void
        : releaseReflectionClaim(
            getMemoryDirectory(),
            context.agent.id,
            saved.conversationId,
            claim,
          ).pipe(Effect.ignore),
    );
    const unreflectedSet = new Set(unreflected);
    const pendingBefore = yield* memoryService.pendingSuggestions();

    const presentationService = yield* PresentationServiceTag;
    const startedAt = Date.now();
    const regionId = yield* presentationService.openEphemeralRegion(
      "subagent",
      "Learning from this conversation",
    );
    let learningFailed = false;
    yield* learnFromConversation({
      unreflectedMessages: unreflected,
      earlierMessages: messages.filter((message) => !unreflectedSet.has(message)),
      sessionChanges: describeSessionMemoryChanges(changes),
      pendingSuggestions:
        pendingBefore.length === 0
          ? "Nothing is waiting."
          : pendingBefore
              .map(
                (suggestion) =>
                  `- [${suggestionKindTag(suggestion)}] ${suggestionDestinationPath(suggestion)}: ${suggestionHeadline(suggestion)}`,
              )
              .join("\n"),
      parentAgent: context.agent,
      conversationId: context.conversationId,
      runRecursive: (runOptions) => AgentRunner.runRecursive(runOptions),
    }).pipe(
      Effect.onError(() => releaseClaim),
      Effect.catch((error) =>
        Effect.gen(function* () {
          learningFailed = true;
          yield* terminal.error(`Could not finish learning: ${error.message}`);
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          presentationService.collapseEphemeralRegion(regionId, "Learning", {
            status: learningFailed ? "failed" : "completed",
            durationMs: Date.now() - startedAt,
          }),
        ),
      ),
    );

    const pendingAfter = yield* memoryService.pendingSuggestions();
    if (pendingAfter.length === 0) {
      if (!learningFailed) {
        yield* terminal.info("Nothing new to learn or tidy.");
      }
      return result;
    }
    const waitingIds = new Set(pendingBefore.map((suggestion) => suggestion.id));
    if (!learningFailed && pendingAfter.every((suggestion) => waitingIds.has(suggestion.id))) {
      yield* terminal.info("Nothing new to learn or tidy; these were already waiting.");
    }
    yield* reviewMemorySuggestions(terminal, memoryService, "/memory");
    return result;
  });
}
