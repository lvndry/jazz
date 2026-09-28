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

/** An entry the slash menu can rank: its name and any other names it answers to. */
export interface RankableCommand {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
}

function namesOf(command: RankableCommand): readonly string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

/**
 * The commands a query matches, in menu order: prefix matches first (in list order), then
 * substring matches, so "/ode" still surfaces /model and /mode. An alias matches too, and case
 * is ignored. The chat composer and home both rank this way.
 */
export function rankCommands<Command extends RankableCommand>(
  commands: readonly Command[],
  query: string,
): Command[] {
  const lower = query.toLowerCase();
  const prefixMatches = commands.filter((command) =>
    namesOf(command).some((name) => name.startsWith(lower)),
  );
  if (lower.length === 0) {
    return prefixMatches;
  }
  const substringMatches = commands.filter(
    (command) =>
      !prefixMatches.includes(command) && namesOf(command).some((name) => name.includes(lower)),
  );
  return [...prefixMatches, ...substringMatches];
}

/**
 * Where a query sits in a name, to bold the matched letters: `[start, end)`, or undefined when
 * the name does not contain it (an alias matched instead).
 */
export function matchedSpan(name: string, query: string): readonly [number, number] | undefined {
  if (query.length === 0) {
    return undefined;
  }
  const start = name.toLowerCase().indexOf(query.toLowerCase());
  return start < 0 ? undefined : [start, start + query.length];
}

/**
 * A description as one plain line. Skill and prompt descriptions are written
 * as markdown for the model; in a one-row menu the `*` and backticks are just
 * noise between the words.
 */
export function plainDescription(description: string): string {
  return description
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The muted tag naming where a non-built-in entry came from. */
export function suggestionOrigin(source: string | undefined): string | undefined {
  switch (source) {
    case "skill":
      return "skill";
    case "mcp-prompt":
      return "mcp";
    case "plugin":
      return "plugin";
    default:
      return undefined;
  }
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
