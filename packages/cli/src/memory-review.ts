/**
 * Reviewing what background passes want to add to memory: fact suggestions and lessons, kept or
 * ignored together from one multi-select list. Shared by `jazz memory review` and `/memory review`
 * so both read the same and decide the same way.
 */

import type { FileSystem } from "@effect/platform";
import type { MemoryService } from "@jazz/core/interfaces/memory-service";
import type { MemorySuggestion } from "@jazz/core/interfaces/memory-suggestion";
import {
  report,
  type PromptChoice,
  type ReportRow,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { storedClaimText } from "@jazz/core/memory/source-trust";
import { suggestionDestinationPath } from "@jazz/core/memory/suggestion-destination";
import { Effect } from "effect";

/** The line a suggestion is known by: the user's quoted words, or the lesson's rule. */
export function suggestionHeadline(suggestion: MemorySuggestion): string {
  return suggestion.kind === "lesson"
    ? suggestion.rule
    : storedClaimText(suggestion.change.content);
}

/** What keeping it does, in a few words. */
export function suggestionConsequence(suggestion: MemorySuggestion): string {
  const destination = suggestionDestinationPath(suggestion);
  if (suggestion.kind === "lesson") {
    return `lesson → ${destination}`;
  }
  return suggestion.change.command === "amend"
    ? `replaces ${destination}`
    : `fact → ${destination}`;
}

/** The context a person needs beyond the headline to decide. */
export function suggestionDetailRows(suggestion: MemorySuggestion): ReportRow[] {
  const rows: ReportRow[] = [
    { kind: "field", key: suggestion.id, value: suggestionHeadline(suggestion) },
  ];
  if (suggestion.kind === "lesson") {
    rows.push({ kind: "text", text: `learned from: ${suggestion.mistake}` });
  } else if (suggestion.change.command === "amend") {
    rows.push({
      kind: "text",
      text: `currently: ${storedClaimText(suggestion.change.previousContent).trim()}`,
    });
  }
  rows.push({ kind: "text", text: `saves to: ${suggestionDestinationPath(suggestion)}` });
  return rows;
}

export function suggestionListRows(suggestions: readonly MemorySuggestion[]): ReportRow[] {
  return [
    { kind: "group", label: "waiting for review", count: String(suggestions.length) },
    ...suggestions.flatMap((suggestion): ReportRow[] => [
      ...suggestionDetailRows(suggestion),
      { kind: "gap" },
    ]),
  ];
}

export function suggestionChoices(
  suggestions: readonly MemorySuggestion[],
): PromptChoice<string>[] {
  return suggestions.map((suggestion) => ({
    name: suggestionHeadline(suggestion),
    value: suggestion.id,
    description: suggestionConsequence(suggestion),
  }));
}

export interface ReviewDecision {
  readonly saved: readonly string[];
  readonly dropped: number;
  /** Kept suggestions that could not be written, with why; they stay waiting. */
  readonly failed: readonly string[];
}

/**
 * Keep the chosen suggestions and drop the rest. A kept suggestion whose write fails stays
 * queued, so a stale amendment is reported rather than lost.
 */
export function applyReviewDecision(
  memoryService: MemoryService,
  suggestions: readonly MemorySuggestion[],
  keptIds: ReadonlySet<string>,
): Effect.Effect<ReviewDecision, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const saved: string[] = [];
    const failed: string[] = [];
    let dropped = 0;
    for (const suggestion of suggestions) {
      if (keptIds.has(suggestion.id)) {
        const outcome = yield* memoryService.acceptSuggestion(suggestion.id);
        if (outcome.success) {
          saved.push(outcome.path ?? suggestionDestinationPath(suggestion));
        } else {
          failed.push(`${suggestion.id}: ${outcome.message}`);
        }
      } else {
        const outcome = yield* memoryService.rejectSuggestion(suggestion.id);
        if (outcome.success) {
          dropped += 1;
        }
      }
    }
    return { saved, dropped, failed };
  });
}

/**
 * Show every waiting suggestion, then one multi-select: checked ones are saved, the rest are
 * dropped. Escape decides nothing and leaves them all waiting. On a terminal that cannot prompt,
 * only the list is shown, with the commands that decide one by one.
 */
export function reviewMemorySuggestions(
  terminal: TerminalService,
  memoryService: MemoryService,
  commandPrefix: "/memory" | "jazz memory",
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const suggestions = yield* memoryService.pendingSuggestions();
    if (suggestions.length === 0) {
      yield* terminal.log(
        report("memory", [{ kind: "text", text: "Nothing waiting for review." }]),
      );
      return;
    }
    const perItemHint = `${commandPrefix} accept <id> keeps one; ${commandPrefix} reject <id> drops it.`;
    yield* terminal.log(report("memory", suggestionListRows(suggestions)));
    if (!terminal.isInteractive) {
      yield* terminal.log(perItemHint);
      return;
    }
    const kept = yield* terminal.checkbox<string>(
      "Check what to keep; the rest is dropped. Esc decides later.",
      { choices: suggestionChoices(suggestions) },
    );
    if (kept === undefined) {
      yield* terminal.log(
        report("memory", [{ kind: "text", text: "Nothing decided; all still waiting." }]),
      );
      return;
    }
    const decision = yield* applyReviewDecision(memoryService, suggestions, new Set(kept));
    const rows: ReportRow[] = [
      ...decision.saved.map((savedPath): ReportRow => ({
        kind: "field",
        key: "saved",
        value: savedPath,
      })),
      ...(decision.dropped > 0
        ? [{ kind: "field", key: "dropped", value: String(decision.dropped) } satisfies ReportRow]
        : []),
    ];
    if (rows.length > 0) {
      yield* terminal.log(report("memory", rows));
    }
    for (const failure of decision.failed) {
      yield* terminal.warn(`Not saved, still waiting — ${failure}`);
    }
  });
}
