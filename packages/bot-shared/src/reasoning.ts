/**
 * @fileoverview Shared rules for surfacing a run's model reasoning in a chat bridge.
 *
 * Both bridges consume the same `thinking_chunk` stream and face the same two
 * conflicting needs: a live progress bubble that has to stay one line (it is
 * edited in place every couple of seconds, under a platform edit rate limit)
 * and a post-run record that should keep everything the model actually thought.
 * The rules live here rather than in either bridge so the two can't drift apart
 * on cap sizes, word boundaries or truncation wording.
 */

/** How much of the accumulated thought the live progress line shows, as a tail. */
export const PROGRESS_REASONING_CHARS = 180;

/**
 * Cutting a tail at a fixed offset usually lands mid-word. A leading run shorter
 * than this is treated as that fragment and dropped; a longer one is plausibly a
 * real word and kept.
 */
const WORD_FRAGMENT_CHARS = 40;

/**
 * Show the latest slice of a streaming thought. Short thoughts render whole;
 * longer ones show the tail from a word boundary with a leading ellipsis, so
 * the line reads as a continuation rather than a chopped-off first word.
 */
export function reasoningSnippet(reasoning: string): string {
  const normalized = reasoning.replace(/\s+/g, " ").trim();
  if (normalized.length <= PROGRESS_REASONING_CHARS) return normalized;
  let tail = normalized.slice(-PROGRESS_REASONING_CHARS).trimStart();
  const firstSpace = tail.indexOf(" ");
  if (firstSpace > 0 && firstSpace < WORD_FRAGMENT_CHARS) tail = tail.slice(firstSpace + 1);
  return `… ${tail}`;
}

/**
 * Tidy the accumulated reasoning for the post-run record. Unlike the progress
 * snippet this keeps line structure — the full log is read as prose, and the
 * model's own paragraph breaks are most of what makes it readable.
 */
export function tidyReasoning(reasoning: string): string {
  return reasoning
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ReasoningSplitOptions {
  /** Characters each part may hold, before any platform wrapper is added. */
  readonly budget: number;
  /** Ceiling on parts, so one very long run can't flood a channel. */
  readonly maxParts: number;
}

/**
 * Split tidied reasoning into parts that each fit a platform's per-message
 * budget, preferring line breaks over hard cuts. If the text needs more parts
 * than `maxParts`, the last part says how much was dropped — a silent cut here
 * would read as "this is all the model thought", which is the one thing the
 * full log exists to disprove.
 */
export function splitReasoning(reasoning: string, options: ReasoningSplitOptions): string[] {
  const tidied = tidyReasoning(reasoning);
  if (tidied.length === 0) return [];

  const parts: string[] = [];
  let remaining = tidied;
  while (remaining.length > options.budget) {
    const window = remaining.slice(0, options.budget);
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    // Prefer a break in the back half of the window; a break near the very start
    // would emit a near-empty part and make no progress on the remainder.
    const halfway = options.budget * 0.5;
    let splitAt = window.length;
    if (lastNewline > halfway) splitAt = lastNewline;
    else if (lastSpace > halfway) splitAt = lastSpace;
    parts.push(window.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();

    if (parts.length === options.maxParts) {
      return withDroppedNote(parts, remaining.length);
    }
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function withDroppedNote(parts: string[], droppedChars: number): string[] {
  if (droppedChars === 0) return parts;
  const note = `\n\n[… ${droppedChars.toLocaleString("en-US")} more characters of reasoning not shown]`;
  const last = parts[parts.length - 1];
  if (last !== undefined) parts[parts.length - 1] = `${last}${note}`;
  return parts;
}
