/**
 * `jazz memory` — see and control what an agent has written down about you.
 *
 * Memory is the one store Jazz keeps that is *about a person* and cannot be
 * re-derived from anything: a preference, an allergy, a relative's name. That
 * makes an inspection surface a correctness requirement rather than a
 * convenience — a person cannot consent to what they cannot see, and the
 * documented failure mode of every auto-writing memory system is that users
 * are fine with memory right up until they discover what it holds.
 *
 * Deliberately operating on the real files: the artifact listed and edited here
 * is byte-for-byte the one the agent reads back, so nothing shown is a
 * regenerated summary that might differ from what actually reaches the model.
 */

import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { readMemoryRecalls, summarizeMemoryRecalls } from "@jazz/core/agent/memory-recall-log";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { CLIError } from "@jazz/core/types/errors";
import { Effect } from "effect";

function resolveScopes(agent: {
  readonly id: string;
  readonly config: { readonly memoryScopes?: readonly string[] | undefined };
}): readonly string[] {
  const configured = agent.config.memoryScopes;
  return configured !== undefined && configured.length > 0 ? configured : [agent.id];
}

/** `jazz memory list <agent>` — every file the agent can read, with provenance. */
export function listMemoryCommand(identifier: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const agent = yield* getAgentByIdentifier(identifier);
    const scopes = resolveScopes(agent);

    const outcome = yield* memoryService.view(scopes, "");
    if (outcome.kind !== "directory") {
      yield* terminal.info("Nothing saved yet.");
      return;
    }

    const files = outcome.entries.filter((entry) => entry.kind === "file");
    if (files.length === 0) {
      yield* terminal.info(`${agent.name} has saved nothing yet. Scopes: ${scopes.join(", ")}.`);
      return;
    }

    yield* terminal.log(`Memory for ${agent.name} (${outcome.path}):\n`);
    for (const file of files) {
      const provenance = yield* memoryService
        .provenance(scopes, file.name)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      const written =
        provenance === undefined
          ? ""
          : `  updated ${provenance.updatedAt.slice(0, 10)}, ${provenance.writeCount} write(s)`;
      yield* terminal.log(`  ${file.name}${written}`);
    }
    yield* terminal.log(`\nRead one with: jazz memory show ${identifier} <path>`);
  });
}

/** `jazz memory show <agent> <path>` — the exact bytes the agent reads back. */
export function showMemoryCommand(identifier: string, memoryPath: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const agent = yield* getAgentByIdentifier(identifier);
    const scopes = resolveScopes(agent);

    const outcome = yield* memoryService.view(scopes, memoryPath);
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
      .provenance(scopes, memoryPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (provenance !== undefined) {
      yield* terminal.log(
        `${outcome.path} — created ${provenance.createdAt.slice(0, 10)}, updated ${provenance.updatedAt.slice(0, 10)}, ${provenance.writeCount} write(s), written by ${provenance.writtenBy.join(", ")}\n`,
      );
    }
    yield* terminal.log(outcome.content);
    yield* terminal.log(`\nEdit it directly: ${outcome.path}`);
  });
}

/** `jazz memory forget <agent> <path>` — delete one file for good. */
export function forgetMemoryCommand(identifier: string, memoryPath: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const memoryService = yield* MemoryServiceTag;
    const agent = yield* getAgentByIdentifier(identifier);
    const scopes = resolveScopes(agent);

    const outcome = yield* memoryService.delete(scopes, memoryPath);
    if (!outcome.success) {
      return yield* Effect.fail(new CLIError({ command: "memory", message: outcome.message }));
    }
    yield* terminal.success(`Forgotten. ${outcome.message}`);
  });
}

/**
 * `jazz memory recall` — the measured rate at which runs consulted memory
 * before answering, split by surface.
 *
 * `view_memory` is tool-call-gated with no preload, so recall is something the
 * model chooses rather than something the harness guarantees. This is how you
 * find out whether it actually happens, per front door, instead of assuming.
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
      yield* terminal.log(
        `  ${rate.surface.padEnd(10)} ${percent.padStart(3)}%  (${rate.viewedBeforeFirstAnswer}/${rate.eligibleRuns} runs)`,
      );
    }
    yield* terminal.log(
      "\nRuns never offered the memory tools are excluded — they cannot be a miss.",
    );
  });
}
