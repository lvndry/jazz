/** A standing entry as the prompt shows it: the scope it came from and its first line. */
export interface ActivePreference {
  readonly scope: string;
  readonly summary: string;
}

/**
 * A `when/<topic>/` entry as the prompt shows it: scope, the situation it applies to, its first
 * line, and the scope-qualified path the memory tools address it by.
 */
export interface SituationalPreference extends ActivePreference {
  readonly topic: string;
  readonly path: string;
}

/** Heading of the system-prompt section listing standing entries. */
export const PREFERENCES_HEADING = "## Preferences";

/** Heading of the system-prompt section listing `when/<topic>/` entries. */
export const SITUATIONAL_PREFERENCES_HEADING = "## Situational preferences";

/**
 * The line a standing entry occupies in the system prompt. Receipts match this
 * exact line to prove the entry reached a request, so both sides share it.
 */
export function formatPreferenceLine(preference: ActivePreference): string {
  return `- [${preference.scope}] ${preference.summary}`;
}

/** A topic directory name read as the situation it names: `writing-to-friends` becomes `writing to friends`. */
export function describeTopicSituation(topic: string): string {
  return topic.replace(/-+/g, " ").trim();
}

/**
 * The line a `when/<topic>/` entry occupies in the system prompt: the situation it applies to in
 * parentheses, its first line, and its path so the model can amend or delete it without a lookup.
 * Receipts match this exact line, so both sides share it.
 */
export function formatSituationalPreferenceLine(preference: SituationalPreference): string {
  return `- [${preference.scope}] (${describeTopicSituation(preference.topic)}) ${preference.summary} [${preference.path}]`;
}

function countLinesInSection(systemPrompt: string, heading: string): number {
  const headingStart = systemPrompt.indexOf(`${heading}\n`);
  if (headingStart === -1) {
    return 0;
  }
  const sectionBody = systemPrompt.slice(headingStart + heading.length + 1);
  const nextHeading = sectionBody.search(/^#{1,6} /m);
  const section = nextHeading === -1 ? sectionBody : sectionBody.slice(0, nextHeading);
  return section.split("\n").filter((line) => line.startsWith("- [")).length;
}

/** How many standing and situational entry lines a system prompt carries. */
export function countInjectedPreferenceLines(systemPrompt: string): number {
  return (
    countLinesInSection(systemPrompt, PREFERENCES_HEADING) +
    countLinesInSection(systemPrompt, SITUATIONAL_PREFERENCES_HEADING)
  );
}
