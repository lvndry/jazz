/**
 * Reviewing what background passes want to change in memory: fact suggestions, lessons and
 * revisions, kept or ignored a checklist at a time. Shared by `jazz memory review` and `/memory review`
 * so both read the same and decide the same way.
 */

import { logDebug } from "@jazz/adapters/logger";
import type { MemoryService } from "@jazz/core/interfaces/memory-service";
import type { MemorySuggestion } from "@jazz/core/interfaces/memory-suggestion";
import {
  report,
  type PromptChoice,
  type PromptTagTone,
  type ReportRow,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { storedClaimText } from "@jazz/core/memory/source-trust";
import { suggestionDestinationPath } from "@jazz/core/memory/suggestion-destination";
import { Effect, type FileSystem } from "effect";
import { PICKER_WINDOW_SIZE } from "./ui/text/picker-window";

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/** An entry's headline: its fact line, or the quoted words of an entry saved as a quote alone. */
function entryHeadline(content: string): string {
  return storedClaimText(firstLine(content));
}

/**
 * The line a suggestion is known by: the fact to remember, the lesson's rule, or for a
 * revision the entry it removes or the rule it rewrites to.
 */
export function suggestionHeadline(suggestion: MemorySuggestion): string {
  if (suggestion.kind === "lesson") {
    return suggestion.rule;
  }
  if (suggestion.kind === "revision") {
    return suggestion.change.command === "delete"
      ? entryHeadline(suggestion.change.previousContent)
      : firstLine(suggestion.change.content);
  }
  return entryHeadline(suggestion.change.content);
}

/** Which kind of change keeping it makes, as a short tag. */
export function suggestionKindTag(suggestion: MemorySuggestion): string {
  if (suggestion.kind === "lesson") {
    return "lesson";
  }
  if (suggestion.kind === "revision") {
    return suggestion.change.command === "delete" ? "remove" : "rewrite";
  }
  return suggestion.change.command === "amend" ? "edit" : "fact";
}

interface SuggestionDetail {
  readonly label: string;
  readonly text: string;
}

/** What a person needs beyond the headline to decide: why a lesson, what an edit replaces, where it saves. */
export function suggestionDetails(suggestion: MemorySuggestion): SuggestionDetail[] {
  const details: SuggestionDetail[] = [];
  if (suggestion.kind === "lesson") {
    details.push({ label: "learned from", text: suggestion.mistake });
  } else if (suggestion.kind === "revision") {
    details.push({ label: "why", text: suggestion.reason });
    if (suggestion.change.command === "rewrite") {
      details.push({ label: "currently", text: firstLine(suggestion.change.previousContent) });
    }
  } else if (suggestion.change.command === "amend") {
    details.push({
      label: "currently",
      text: entryHeadline(suggestion.change.previousContent),
    });
  }
  const removes = suggestion.kind === "revision" && suggestion.change.command === "delete";
  details.push({
    label: removes ? "removes" : "saves to",
    text: suggestionDestinationPath(suggestion),
  });
  return details;
}

export function suggestionDetailRows(suggestion: MemorySuggestion): ReportRow[] {
  return [
    { kind: "field", key: suggestion.id, value: suggestionHeadline(suggestion) },
    ...suggestionDetails(suggestion).map((detail): ReportRow => ({
      kind: "text",
      text: `${detail.label}: ${detail.text}`,
    })),
  ];
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

function suggestionTagTone(suggestion: MemorySuggestion): PromptTagTone {
  if (suggestion.kind === "lesson") {
    return "accent";
  }
  if (suggestion.kind === "revision" && suggestion.change.command === "delete") {
    return "warning";
  }
  return "muted";
}

/** One row per suggestion; its details show in the highlighted row's preview, in both renderers. */
export function suggestionChoices(
  suggestions: readonly MemorySuggestion[],
): PromptChoice<string>[] {
  return suggestions.map((suggestion) => ({
    name: suggestionHeadline(suggestion),
    value: suggestion.id,
    tag: suggestionKindTag(suggestion),
    tagTone: suggestionTagTone(suggestion),
    preview: suggestionDetails(suggestion).map((detail) => [
      { text: `${detail.label}: ${detail.text}` },
    ]),
  }));
}

export interface ReviewDecision {
  readonly saved: readonly string[];
  /** Entries a kept removal deleted. */
  readonly removed: readonly string[];
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
    const removed: string[] = [];
    const failed: string[] = [];
    let dropped = 0;
    for (const suggestion of suggestions) {
      if (keptIds.has(suggestion.id)) {
        const outcome = yield* memoryService.acceptSuggestion(suggestion.id);
        if (outcome.success) {
          const entryPath = outcome.path ?? suggestionDestinationPath(suggestion);
          if (suggestion.kind === "revision" && suggestion.change.command === "delete") {
            removed.push(entryPath);
          } else {
            saved.push(entryPath);
          }
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
    return { saved, removed, dropped, failed };
  });
}

/**
 * Suggestions decided per checklist: exactly one picker window, so every unchecked row that
 * gets dropped was on screen when Enter was pressed.
 */
export const REVIEW_PAGE_SIZE = PICKER_WINDOW_SIZE;

export function reviewPageTitle(pageStart: number, pageLength: number, total: number): string {
  if (total <= REVIEW_PAGE_SIZE) {
    return `${String(total)} waiting. Check what to keep; the rest is dropped. Esc decides later.`;
  }
  const pageEnd = pageStart + pageLength;
  const range = `${String(pageStart + 1)}–${String(pageEnd)} of ${String(total)}`;
  if (pageEnd >= total) {
    return `${range} waiting. Check what to keep; unchecked ones on this page are dropped. Esc leaves this page waiting.`;
  }
  const next = `${String(pageEnd + 1)}–${String(Math.min(pageEnd + REVIEW_PAGE_SIZE, total))}`;
  return `${range} waiting. Check what to keep; unchecked ones on this page are dropped, then ${next} come next. Esc stops and leaves this page and later ones waiting.`;
}

/**
 * Checklists of at most {@link REVIEW_PAGE_SIZE} waiting suggestions, one after another: checked
 * ones are saved, unchecked ones on that checklist are dropped. Escape stops the review and leaves
 * the current checklist and every later one waiting. On a terminal that cannot prompt, the list is
 * printed instead, with the commands that decide one by one.
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
    if (!terminal.isInteractive) {
      yield* terminal.log(report("memory", suggestionListRows(suggestions)));
      yield* terminal.log(
        `${commandPrefix} accept <id> keeps one; ${commandPrefix} reject <id> drops it.`,
      );
      return;
    }
    const saved: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    let dropped = 0;
    let stillWaiting = 0;
    for (let pageStart = 0; pageStart < suggestions.length; pageStart += REVIEW_PAGE_SIZE) {
      const page = suggestions.slice(pageStart, pageStart + REVIEW_PAGE_SIZE);
      const kept = yield* terminal.checkbox<string>(
        reviewPageTitle(pageStart, page.length, suggestions.length),
        { choices: suggestionChoices(page) },
      );
      if (kept === undefined) {
        stillWaiting = suggestions.length - pageStart;
        logDebug("memory review stopped", { pageStart, stillWaiting, total: suggestions.length });
        break;
      }
      const pageDecision = yield* applyReviewDecision(memoryService, page, new Set(kept));
      logDebug("memory review page decided", {
        pageStart,
        pageLength: page.length,
        saved: pageDecision.saved.length,
        removed: pageDecision.removed.length,
        dropped: pageDecision.dropped,
        failed: pageDecision.failed.length,
      });
      saved.push(...pageDecision.saved);
      removed.push(...pageDecision.removed);
      failed.push(...pageDecision.failed);
      dropped += pageDecision.dropped;
    }
    if (stillWaiting === suggestions.length) {
      yield* terminal.log(
        report("memory", [{ kind: "text", text: "Nothing decided; all still waiting." }]),
      );
      return;
    }
    const decision: ReviewDecision = { saved, removed, dropped, failed };
    const rows: ReportRow[] = [
      ...decision.saved.map((savedPath): ReportRow => ({
        kind: "field",
        key: "saved",
        value: savedPath,
      })),
      ...decision.removed.map((removedPath): ReportRow => ({
        kind: "field",
        key: "removed",
        value: removedPath,
      })),
      ...(decision.dropped > 0
        ? [{ kind: "field", key: "dropped", value: String(decision.dropped) } satisfies ReportRow]
        : []),
      ...(stillWaiting > 0
        ? [{ kind: "field", key: "waiting", value: String(stillWaiting) } satisfies ReportRow]
        : []),
    ];
    if (rows.length > 0) {
      yield* terminal.log(report("memory", rows));
    }
    for (const failure of decision.failed) {
      yield* terminal.warn(`Not applied, still waiting — ${failure}`);
    }
  });
}
