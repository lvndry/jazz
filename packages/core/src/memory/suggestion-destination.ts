import { ALWAYS_SEGMENT, buildMemoryEntryPath } from "./entry-path";
import type { LessonProposalInput, MemorySuggestion } from "../interfaces/memory-suggestion";

/** Where a lesson is saved once accepted, shown to the person before they accept it. */
export function lessonDestinationPath(
  proposal: Pick<LessonProposalInput, "scope" | "subject" | "topic">,
): string {
  return buildMemoryEntryPath({
    scope: proposal.scope,
    subject: proposal.subject,
    ...(proposal.topic !== ALWAYS_SEGMENT ? { topic: proposal.topic } : {}),
  });
}

/** The entry a suggestion writes, rewrites or removes once kept. */
export function suggestionDestinationPath(suggestion: MemorySuggestion): string {
  return suggestion.kind === "lesson" ? lessonDestinationPath(suggestion) : suggestion.change.path;
}
