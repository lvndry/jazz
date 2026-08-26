/**
 * @fileoverview What the composer's suggestion menu is showing
 *
 * Slash commands and `@` file mentions share one menu, one selection index, and
 * one set of keys, across two independent composers — the fullscreen renderer
 * and the Ink fallback. The rule for which of the two is live therefore has to
 * live in exactly one place: encoded per-composer it agrees only until someone
 * edits one copy, and then the fallback silently behaves differently from the
 * thing it is a fallback for.
 */

/** Sigils the suggestion menu can complete. */
export type SuggestionPrefix = "/" | "@";

/** The shape both composers' suggestion rows share. */
export interface SuggestionEntry {
  readonly name: string;
  readonly description: string;
  readonly usage?: string | undefined;
  readonly source?: string | undefined;
}

export interface SuggestionMenu<Entry extends SuggestionEntry = SuggestionEntry> {
  readonly items: readonly Entry[];
  readonly prefix: SuggestionPrefix;
}

/**
 * Pick which suggestions the menu shows.
 *
 * Slash commands win: a line starting with `/` cannot also hold a mention span,
 * so an overlap means the caller resolved the two differently and the command
 * is the more specific read. Returns undefined when there is nothing to show,
 * which is the signal to hide the menu entirely.
 */
export function mergeSuggestions<Command extends SuggestionEntry, Mention extends SuggestionEntry>(
  commands: readonly Command[],
  mentions: readonly Mention[],
): SuggestionMenu<Command | Mention> | undefined {
  if (commands.length > 0) return { items: commands, prefix: "/" };
  if (mentions.length > 0) return { items: mentions, prefix: "@" };
  return undefined;
}
