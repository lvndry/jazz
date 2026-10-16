/**
 * `jazz memory` — see and control what Jazz has written down about you.
 *
 * Memory is the one store Jazz keeps that is *about a person* and cannot be
 * re-derived from anything: a preference, an allergy, a relative's name. That
 * makes an inspection surface a correctness requirement rather than a
 * convenience — a person cannot consent to what they cannot see, and the
 * documented failure mode of every auto-writing memory system is that users
 * are fine with memory right up until they discover what it holds.
 *
 * Memory is shared by every agent and partitioned into scopes, which are
 * topics rather than ownership: `personal`, `finance`, the name of a project.
 * The commands here therefore operate on scopes and paths directly — there is
 * no agent to name, because there is no per-agent view to select.
 *
 * Deliberately operating on the real files: the artifact listed and edited
 * here is byte-for-byte the one the agents read back, so nothing shown is a
 * regenerated summary that might differ from what actually reaches the model.
 */

import { loadConversationOrNull } from "@jazz/adapters/history/conversation-history-service";
import { claimUnreflectedMessages } from "@jazz/adapters/reflection-watermark";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { extractMemories } from "@jazz/core/agent/context/memory-extractor";
import {
  DEFAULT_RECEIPT_READ_LIMIT,
  MAX_RECEIPTS_PER_ENTRY,
  readMemoryOpportunityReceipts,
} from "@jazz/core/agent/memory-opportunity-receipts";
import { readMemoryRecalls, summarizeMemoryRecalls } from "@jazz/core/agent/memory-recall-log";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { splitScopeAndRest } from "@jazz/core/memory/entry-path";
import { CLIError } from "@jazz/core/types/errors";
import { isAgentStartedProcess } from "@jazz/core/utils/env";
import { getMemoryDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { reviewMemorySuggestions } from "../memory-review";

/** `jazz memory list [scope]` — every scope on disk, or every file in one scope. */
export function listMemoryCommand(scope?: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;

    if (scope === undefined) {
      const outcome = yield* memoryService.view("");
      if (outcome.kind !== "directory") {
        yield* terminal.info("Nothing saved yet.");
        return;
      }
      if (outcome.entries.length === 0) {
        yield* terminal.info("Nothing saved yet. Scopes appear here as agents write them.");
        return;
      }
      yield* terminal.log("Memory scopes (shared by all agents):\n");
      // The root view is a recursive tree, so each top-level scope directory
      // is the entries' first path segment; count the files nested under it.
      const scopes = outcome.entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.name.replace(/\/$/, ""))
        .filter((name) => name.indexOf("/") === -1);
      for (const scopeName of scopes) {
        const count = outcome.entries.filter(
          (entry) => entry.kind === "file" && entry.name.startsWith(`${scopeName}/`),
        ).length;
        yield* terminal.log(`  ${scopeName}${count > 0 ? `  (${count} file(s))` : "  (empty)"}`);
      }
      yield* terminal.log("\nDrill in with: jazz memory list <scope>");
      return;
    }

    const normalized = scope.replace(/\/$/, "");
    const outcome = yield* memoryService.view(normalized);
    if (outcome.kind === "not_found") {
      yield* terminal.info(`No such scope: ${normalized}`);
      return;
    }
    if (outcome.kind !== "directory") {
      yield* terminal.info(`${normalized} is a file. Use: jazz memory show ${normalized}`);
      return;
    }
    const files = outcome.entries.filter((entry) => entry.kind === "file");
    if (files.length === 0) {
      yield* terminal.info(`Scope ${normalized} has no files yet.`);
      return;
    }
    yield* terminal.log(`Memory in ${normalized}:\n`);
    for (const file of files) {
      const provenance = yield* memoryService
        .provenance(`${normalized}/${file.name}`)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      const written =
        provenance === undefined
          ? ""
          : `  updated ${provenance.updatedAt.slice(0, 10)}, ${provenance.writeCount} write(s)`;
      yield* terminal.log(`  ${file.name}${written}`);
    }
    yield* terminal.log(`\nRead one with: jazz memory show ${normalized}/<path>`);
  });
}

/** `jazz memory show <path>` — the exact bytes every agent reads back. */
export function showMemoryCommand(memoryPath: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;

    const outcome = yield* memoryService.view(memoryPath);
    if (outcome.kind === "not_found" || outcome.kind === "too_large") {
      return yield* Effect.fail(new CLIError({ command: "memory", message: outcome.message }));
    }
    if (outcome.kind === "directory") {
      for (const entry of outcome.entries) {
        yield* terminal.log(`  ${entry.name}`);
      }
      return;
    }

    const provenance = yield* memoryService
      .provenance(memoryPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (provenance !== undefined) {
      yield* terminal.log(
        `${outcome.displayPath} — created ${provenance.createdAt.slice(0, 10)}, updated ${provenance.updatedAt.slice(0, 10)}, ${provenance.writeCount} write(s), written by ${provenance.writtenBy.join(", ")}\n`,
      );
    }
    yield* terminal.log(outcome.content);
    yield* terminal.log(`\nEdit it directly: ${outcome.displayPath}`);
  });
}

/** `jazz memory forget <path>` — delete one file for good. */
export function forgetMemoryCommand(memoryPath: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;

    const outcome = yield* memoryService.delete(memoryPath);
    if (!outcome.success) {
      return yield* Effect.fail(new CLIError({ command: "memory", message: outcome.message }));
    }
    yield* terminal.success(`Forgotten. ${outcome.message}`);
  });
}

/** `jazz memory explain <path>` — show stored entry provenance. */
export function explainMemoryCommand(memoryPath: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const provenance = yield* memoryService.provenance(memoryPath);
    if (provenance === undefined) {
      return yield* Effect.fail(
        new CLIError({ command: "memory explain", message: `No provenance for ${memoryPath}` }),
      );
    }
    yield* terminal.log(`Memory: ${memoryPath}`);
    yield* terminal.log(`Created: ${provenance.createdAt}`);
    yield* terminal.log(`Updated: ${provenance.updatedAt}`);
    yield* terminal.log(`Origin: ${provenance.origin ?? "unknown"}`);
    yield* terminal.log(`Writes: ${provenance.writeCount}`);
    if (provenance.entryId !== undefined) {
      const entryId = provenance.entryId;
      const { scope } = splitScopeAndRest(memoryPath);
      const receipts = yield* readMemoryOpportunityReceipts(
        scope ?? "",
        entryId,
        DEFAULT_RECEIPT_READ_LIMIT,
      ).pipe(
        Effect.mapError(
          (error) =>
            new CLIError({
              command: "memory explain",
              message: `Could not read opportunity receipts: ${error.message}`,
            }),
        ),
      );
      yield* terminal.log(
        `Recent opportunity receipts (last ${DEFAULT_RECEIPT_READ_LIMIT}; ${MAX_RECEIPTS_PER_ENTRY} kept): ${receipts.length}`,
      );
      for (const receipt of receipts) {
        const exposureKinds = receipt.exposures.map((exposure) => exposure.kind).join(",");
        yield* terminal.log(
          `  ${receipt.opportunityAt} ${receipt.status} exposures=${exposureKinds || "none"}`,
        );
      }
    }
    if (provenance.failure !== undefined) {
      yield* terminal.log(`Prevents failure: ${JSON.stringify(provenance.failure)}`);
    }
  });
}

/**
 * `jazz memory recall` — the measured rate at which runs consulted memory
 * before answering, split by surface.
 *
 * Standing and situational entries are injected into every run, so the percentage here counts
 * only the lookups the model chose to make with `view_memory`; the injected average is the
 * entries it saw without asking. This is how you find out, per front door, what actually
 * reaches the model instead of assuming.
 */
export function memoryRecallCommand(options: { readonly surface?: string }) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const entries = yield* readMemoryRecalls(
      options.surface !== undefined ? { surface: options.surface } : undefined,
    );
    const rates = summarizeMemoryRecalls(entries);

    if (rates.length === 0) {
      yield* terminal.info(
        "No runs recorded yet. The log fills as agents with memory enabled complete runs.",
      );
      return;
    }

    yield* terminal.log("Runs that consulted memory before answering:\n");
    for (const rate of rates) {
      const percent = (rate.rate * 100).toFixed(0);
      const injected =
        rate.averageInjected === undefined
          ? ""
          : `  ${rate.averageInjected.toFixed(1)} entries injected per run`;
      yield* terminal.log(
        `  ${rate.surface.padEnd(10)} ${percent.padStart(3)}%  (${rate.viewedBeforeFirstAnswer}/${rate.eligibleRuns} runs)${injected}`,
      );
    }
    yield* terminal.log(
      "\nRuns never offered the memory tools are excluded — they cannot be a miss.",
    );
  });
}

/**
 * `jazz memory review` — facts background passes picked and lessons agents drew from their own
 * mistakes, kept or ignored together from one list.
 *
 * Nothing here is memory until the person keeps it: the passes chose it without the person
 * watching, and a lesson is the agent's wording rather than the person's.
 */
export function reviewSuggestionsCommand() {
  return Effect.gen(function* () {
    if (isAgentStartedProcess()) {
      return yield* Effect.fail(
        new CLIError({
          command: "memory review",
          message:
            "Reviewing memory suggestions is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.",
        }),
      );
    }
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    yield* reviewMemorySuggestions(terminal, memoryService, "jazz memory");
  });
}

/** Accept only a person-started command; a shell tool cannot approve its own lesson. */
export function acceptSuggestionCommand(id: string) {
  return Effect.gen(function* () {
    if (isAgentStartedProcess()) {
      return yield* Effect.fail(
        new CLIError({
          command: "memory accept",
          message:
            "Accepting a memory suggestion is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.",
        }),
      );
    }
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const outcome = yield* memoryService.acceptSuggestion(id);
    if (!outcome.success) {
      return yield* Effect.fail(
        new CLIError({ command: "memory accept", message: outcome.message }),
      );
    }
    yield* terminal.success(outcome.message);
  });
}

export function rejectSuggestionCommand(id: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const outcome = yield* memoryService.rejectSuggestion(id);
    if (!outcome.success) {
      return yield* Effect.fail(
        new CLIError({ command: "memory reject", message: outcome.message }),
      );
    }
    yield* terminal.success(outcome.message);
  });
}

/**
 * `jazz memory reflect` — internal: suggest facts and lessons from what was said in a conversation
 * since it was last reflected on, reading the part already reflected on as context. The chat starts this detached when a conversation is closed or left, so
 * the person never waits on it.
 */
export function reflectConversationCommand(options: {
  readonly agent: string;
  readonly conversation: string;
}) {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(options.agent);
    const conversation = yield* loadConversationOrNull(agent.id, options.conversation);
    if (conversation === null) {
      return;
    }
    const unreflected = yield* claimUnreflectedMessages(
      getMemoryDirectory(),
      agent.id,
      conversation.conversationId,
      conversation.messages,
    );
    if (!unreflected.some((message) => message.role === "assistant")) {
      return;
    }
    const unreflectedSet = new Set(unreflected);
    yield* extractMemories(
      unreflected,
      agent,
      conversation.conversationId,
      (runOptions) => AgentRunner.runRecursive(runOptions),
      "conversation-end",
      {
        earlierMessages: conversation.messages.filter(
          (message) => message.role !== "system" && !unreflectedSet.has(message),
        ),
      },
    );
  });
}
