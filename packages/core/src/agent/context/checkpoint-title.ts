/**
 * The conversation name a compaction checkpoint carries. The summarizer writes it under
 * {@link CHECKPOINT_TITLE_HEADING}, and history names a conversation the user never renamed
 * after its latest checkpoint.
 */

import { cleanConversationTitle } from "../conversation-title-text";

export const CHECKPOINT_TITLE_HEADING = "## Title";

/**
 * The title under the checkpoint's {@link CHECKPOINT_TITLE_HEADING}: its first non-empty line,
 * cleaned by {@link cleanConversationTitle}. Undefined when the section is missing, empty, or
 * `(none)`.
 */
export function checkpointTitle(content: string): string | undefined {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === CHECKPOINT_TITLE_HEADING);
  if (headingIndex === -1) {
    return undefined;
  }
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      return undefined;
    }
    if (trimmed.toLowerCase() === "(none)") {
      return undefined;
    }
    const title = cleanConversationTitle(trimmed);
    if (title !== undefined) {
      return title;
    }
  }
  return undefined;
}
