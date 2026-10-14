import { ALWAYS_SEGMENT, buildMemoryEntryPath } from "./entry-path";
import type { LessonProposal } from "../interfaces/lesson-proposal";

/** Where a lesson is saved once accepted, shown to the person before they accept it. */
export function lessonDestinationPath(
  proposal: Pick<LessonProposal, "scope" | "subject" | "topic">,
): string {
  return buildMemoryEntryPath({
    scope: proposal.scope,
    subject: proposal.subject,
    ...(proposal.topic !== ALWAYS_SEGMENT ? { topic: proposal.topic } : {}),
  });
}
