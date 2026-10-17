/**
 * The conversation name a compaction checkpoint carries. The summarizer writes it under
 * {@link CHECKPOINT_TITLE_HEADING}, and history names a conversation the user never renamed
 * after its latest checkpoint.
 */

export const CHECKPOINT_TITLE_HEADING = "## Title";

/** Longest title taken from a checkpoint; the summarizer is asked for a few words. */
const MAX_CHECKPOINT_TITLE_CHARS = 80;

/**
 * The title under the checkpoint's {@link CHECKPOINT_TITLE_HEADING}: its first non-empty line,
 * without Markdown emphasis or wrapping quotes. Undefined when the section is missing, empty,
 * or `(none)`.
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
    const title = trimmed
      .replace(/^[-*]\s+/, "")
      .replace(/^[*_`"'“]+|[*_`"'”.]+$/g, "")
      .replace(/\p{Cc}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length === 0) {
      continue;
    }
    if (title.toLowerCase() === "(none)") {
      return undefined;
    }
    const characters = Array.from(title);
    return characters.length > MAX_CHECKPOINT_TITLE_CHARS
      ? `${characters
          .slice(0, MAX_CHECKPOINT_TITLE_CHARS - 1)
          .join("")
          .trimEnd()}…`
      : title;
  }
  return undefined;
}
