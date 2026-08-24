/**
 * @fileoverview Detecting the `@path` the user is mid-way through typing
 *
 * The slash-command picker can work off the whole line, because a command only
 * ever sits at the start of it. An `@` mention can appear anywhere in a
 * sentence, several times over, so the span being completed has to be located
 * relative to the caret rather than the line.
 *
 * Path *resolution* already happens after submit (see
 * `core/agent/user-input-attachments`); this module only decides what to
 * suggest while typing.
 */

/**
 * The `@…` span under the caret.
 *
 * Offsets are **code-point** indices, not UTF-16 ones, because that is what the
 * composer's caret is. Mixing the two silently misplaces the replacement as
 * soon as anything astral — an emoji in the message or in a filename — sits
 * before the caret.
 */
export interface AtMentionSpan {
  /** Text between the `@` and the caret — what to search for. */
  readonly query: string;
  /** Index of the `@` itself. */
  readonly start: number;
  /** Index one past the end of the span. */
  readonly end: number;
}

/**
 * Locate the mention being typed, or null when the caret is not in one.
 *
 * An `@` only opens a mention at the start of the line or after whitespace, so
 * an email address or a decorator does not turn the picker on mid-word. The
 * query itself stops at whitespace: a path with spaces in it is still
 * attachable, but the user picks it from the menu rather than typing it, and
 * treating a following word as part of the query would keep the menu open over
 * the rest of the sentence.
 */
export function atMentionSpan(text: string, caret: number): AtMentionSpan | null {
  const characters = [...text];
  const clampedCaret = Math.max(0, Math.min(caret, characters.length));

  for (let index = clampedCaret - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) return null;

    if (character === "@") {
      const preceding = index === 0 ? undefined : characters[index - 1];
      if (preceding !== undefined && !/\s/.test(preceding)) return null;
      return {
        query: characters.slice(index + 1, clampedCaret).join(""),
        start: index,
        end: clampedCaret,
      };
    }

    // Whitespace closes the candidate: whatever is under the caret is a plain
    // word, not a mention.
    if (/\s/.test(character)) return null;
  }

  return null;
}

/**
 * Replace a mention span with a chosen path, leaving the caret after it.
 *
 * A trailing space is added so the next keystroke starts a new word rather than
 * re-opening the menu on the path just accepted.
 */
export function applyAtMention(
  text: string,
  span: AtMentionSpan,
  replacement: string,
): { readonly text: string; readonly caret: number } {
  const characters = [...text];
  const inserted = [...`@${replacement} `];
  const next = [
    ...characters.slice(0, span.start),
    ...inserted,
    ...characters.slice(span.end),
  ].join("");
  return { text: next, caret: span.start + inserted.length };
}
