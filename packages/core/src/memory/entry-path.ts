/**
 * Where a memory entry lives, and when it applies.
 *
 * An entry is a markdown file. The directory it sits in says when it should be
 * in front of the model, which is the only question about an entry that changes
 * behaviour:
 *
 *   <scope>/always/<slug>.md          in force on every task
 *   <scope>/when/<topic>/<slug>.md    in force when that topic is active
 *
 * There is deliberately no kind, category, or type. "Lives in Paris" and "reply
 * concisely" are not usefully different genres of thing — they differ in when
 * they should apply, and that is what the layout encodes.
 *
 * The tree is the index. Nothing about an entry is recorded a second time
 * somewhere else, so there is no copy to drift, no cache to invalidate, and a
 * file created or deleted by hand behaves exactly like one written by the tool.
 */
import { MAX_MEMORY_PATH_SEGMENT_LENGTH } from "../constants/memory";

/** Entries in force on every task. */
export const ALWAYS_SEGMENT = "always";

/** Parent of the per-topic directories. */
export const WHEN_SEGMENT = "when";

/**
 * Longest slug that still fits a path segment once `.md` is appended.
 *
 * Slicing to the segment cap itself would build a segment the path guardrail
 * then rejects — and the caller chose a subject, not a path, so that error
 * would be unactionable.
 */
export const MAX_MEMORY_SLUG_LENGTH = MAX_MEMORY_PATH_SEGMENT_LENGTH - ".md".length;

/**
 * Normalizes free text into a path-safe segment.
 *
 * Applied to both subjects and topics so a subject and the filename it produces
 * agree: the filename is an entry's identity, so two spellings of one subject
 * have to land on the same file for the second write to be recognised as
 * touching the first.
 */
export function slugifyMemorySegment(value: string): string {
  return (
    value
      .normalize("NFD")
      // Marks are dropped rather than left to become separators, so an accented
      // spelling lands on the same file as an unaccented one.
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_MEMORY_SLUG_LENGTH)
      .replace(/-+$/g, "")
  );
}

/**
 * Explains why a subject cannot be stored, or returns `undefined` when it can.
 *
 * A subject of only punctuation or non-Latin characters slugifies to nothing,
 * which would otherwise write a bare `.md` file: hidden from every listing and
 * from the quota walk, yet still recalled.
 */
export function describeUnusableSubject(subject: string): string | undefined {
  if (slugifyMemorySegment(subject).length > 0) return undefined;
  return `Subject ${JSON.stringify(subject)} contains no letters or digits that can be stored in a path. Give a subject containing Latin letters or digits.`;
}

/**
 * Explains why a topic cannot be stored, or returns `undefined` when it can.
 *
 * An explicitly supplied topic that normalizes to nothing would silently file
 * the entry under `always/` — the caller asked for topic scoping and should
 * learn the topic is unusable rather than having it dropped.
 */
export function describeUnusableTopic(topic: string): string | undefined {
  if (slugifyMemorySegment(topic).length > 0) return undefined;
  return `Topic ${JSON.stringify(topic)} contains no letters or digits that can be stored in a path. Give a topic containing Latin letters or digits, or omit it to apply this entry to every task.`;
}

export interface BuildMemoryEntryPathInput {
  readonly scope: string;
  readonly subject: string;
  /** Omitted stores the entry as in force on every task. */
  readonly topic?: string;
}

/** The path an entry must live at, given what it is about and when it applies. */
export function buildMemoryEntryPath(input: BuildMemoryEntryPathInput): string {
  const slug = `${slugifyMemorySegment(input.subject)}.md`;
  const topic = input.topic === undefined ? undefined : slugifyMemorySegment(input.topic);

  return topic === undefined || topic.length === 0
    ? `${input.scope}/${ALWAYS_SEGMENT}/${slug}`
    : `${input.scope}/${WHEN_SEGMENT}/${topic}/${slug}`;
}
