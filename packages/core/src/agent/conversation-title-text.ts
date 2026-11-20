/** Longest conversation title kept; titles are asked for in a few words. */
export const MAX_CONVERSATION_TITLE_CHARS = 80;

/**
 * One line cleaned into a title: list markers, Markdown emphasis, wrapping quotes and a trailing
 * period dropped, control characters removed, whitespace collapsed, capped at
 * {@link MAX_CONVERSATION_TITLE_CHARS}. Undefined when nothing is left or the line is `(none)`.
 */
export function cleanConversationTitle(line: string): string | undefined {
  const title = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^(?:title\s*:\s*)/i, "")
    .replace(/^[*_`"'“]+|[*_`"'”.]+$/g, "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0 || title.toLowerCase() === "(none)") {
    return undefined;
  }
  const characters = Array.from(title);
  if (characters.length <= MAX_CONVERSATION_TITLE_CHARS) {
    return title;
  }
  return `${characters
    .slice(0, MAX_CONVERSATION_TITLE_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}
