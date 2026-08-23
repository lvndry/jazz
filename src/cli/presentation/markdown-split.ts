/**
 * Pure, heuristic-based split-point finder for streaming markdown text.
 *
 * Used by the streaming output buffer to decide how much of the unsettled
 * pending tail can be safely promoted to terminal scrollback (<Static>) without
 * breaking markdown formatting or rendering an in-flight construct twice.
 *
 * Heuristic, not parser. A "wrong" split is purely cosmetic — the same text
 * still renders, just split into two adjacent blocks. A *missing* split is
 * what we care about; the rules below guarantee a split at every paragraph
 * boundary in normal prose.
 *
 * Two entry points:
 * - `findLastSafeSplitPoint(text)` — pure, one-shot, scans `text` once.
 * - `createStreamSplitScanner()` — stateful; commits each line of the pending
 *   tail exactly once across a run of appends, so streaming a block costs
 *   O(tail) in total rather than O(tail²). The one-shot function is a thin
 *   wrapper over a throwaway scanner, so both share one implementation.
 */

/** Hard cap on pending tail size. Triggers a forced last-newline fallback. */
export const MAX_PENDING_TAIL = 8192;

/** Never split inside the trailing N chars — too likely to be in-flight. */
export const SOFT_TAIL = 256;

const FENCE_MARKERS = ["```", "~~~"] as const;
const SENTENCE_TERMINATORS = [".", "?", "!"] as const;

/**
 * How much of the in-flight partial line to inspect when asking "is this line
 * a list item?". A list marker sits within the first few chars of a line, so a
 * bounded probe answers the question without rescanning a long line on every
 * delta.
 */
const LIST_MARKER_PROBE = 64;

/**
 * Incremental split-point finder over a growing pending tail.
 *
 * `evaluate` must be called with text that extends what it was last called
 * with (the pending buffer only ever grows by appended deltas). Anything else
 * — a shorter string, or a rebased tail after a promotion — must go through
 * `reset`, or a fresh scanner. Re-evaluating the *same* text is safe and free,
 * so a replayed reducer dispatch costs nothing.
 */
export interface StreamSplitScanner {
  /** Highest safe split offset in `text`, or 0 when nothing can be promoted. */
  evaluate(text: string): number;
  /** Drop all committed state; the next `evaluate` rescans from offset 0. */
  reset(): void;
}

export function createStreamSplitScanner(): StreamSplitScanner {
  return new LineScanner();
}

/**
 * Return the highest offset in `text` that is "safe" to split at — meaning
 * the markdown structure before that offset is fully self-contained and can
 * be promoted to scrollback without losing formatting context.
 *
 * Returns 0 when no safe split exists yet. Callers treat any return value
 * greater than 0 as the promotion boundary; 0 means "nothing to promote yet,
 * leave the buffer alone".
 */
export function findLastSafeSplitPoint(text: string): number {
  return new LineScanner().evaluate(text);
}

/**
 * Line-at-a-time scanner behind both entry points.
 *
 * Every candidate rule the splitter uses (closing fence, blank line, end of
 * list block, heading end, sentence end) resolves to an offset immediately
 * after a newline, so each one can be recognized while committing the line
 * that produced it and remembered as an offset. Candidates are discovered in
 * increasing order, which keeps each list sorted and makes "highest candidate
 * at or below `upperBound`" a binary search.
 *
 * Only complete lines are committed. The trailing partial line is re-derived
 * on every `evaluate` — it is one line, and it is the only part of the text
 * that a new delta can change.
 */
class LineScanner implements StreamSplitScanner {
  /** Offset just past the last committed newline; start of the partial line. */
  private committedLength = 0;

  private openFenceMarker: string | null = null;
  private openFenceStart: number | null = null;

  private readonly closingFenceCandidates: number[] = [];
  /** Offsets of `\n\n` occurrences, not the candidates they imply. */
  private readonly blankLineStarts: number[] = [];
  private readonly listBlockEndCandidates: number[] = [];
  private readonly headingEndCandidates: number[] = [];
  private readonly sentenceEndCandidates: number[] = [];
  /**
   * Sentence ends whose following char is a newline. A sentence end only
   * counts when something other than a blank line follows it — a paragraph
   * break is the blank-line rule's business — so these are held apart and
   * only used when the split bound lands exactly on them.
   */
  private readonly sentenceEndBeforeBlankCandidates: number[] = [];
  /**
   * Sentence end of the last committed line, before the next line has
   * arrived to say which of the two lists above it belongs in.
   */
  private unclassifiedSentenceEnd: number | null = null;

  private lastCommittedLineIsList = false;
  /** Start of the contiguous list run ending at the last committed line. */
  private runStartOfLastCommittedLine: number | null = null;
  /** Start of the last contiguous list run seen anywhere in committed text. */
  private lastListRunStart: number | null = null;
  /** End offset (excluding its newline) of the last committed list line. */
  private lastListLineEnd = -1;

  reset(): void {
    this.committedLength = 0;
    this.openFenceMarker = null;
    this.openFenceStart = null;
    this.closingFenceCandidates.length = 0;
    this.blankLineStarts.length = 0;
    this.listBlockEndCandidates.length = 0;
    this.headingEndCandidates.length = 0;
    this.sentenceEndCandidates.length = 0;
    this.sentenceEndBeforeBlankCandidates.length = 0;
    this.unclassifiedSentenceEnd = null;
    this.lastCommittedLineIsList = false;
    this.runStartOfLastCommittedLine = null;
    this.lastListRunStart = null;
    this.lastListLineEnd = -1;
  }

  evaluate(text: string): number {
    if (text.length < this.committedLength) this.reset();
    this.commitCompletedLines(text);
    if (text.length === 0) return 0;

    const partialLine = text.slice(this.committedLength);

    // 1. Compute the floor: the earliest offset still inside an open structure.
    //    Split point cannot exceed this floor.
    const floor = this.computeOpenStructureFloor(text, partialLine);
    const hasOpenStructure = floor < text.length;

    // 2. Bound the search.
    //    - When there's an open structure, the floor IS the in-flight construct,
    //      so it already plays the role of the soft tail. Don't apply soft tail
    //      on top of it.
    //    - When there's no open structure, the soft tail leaves a buffer.
    const upperBound = hasOpenStructure ? floor : Math.max(0, text.length - SOFT_TAIL);

    if (upperBound <= 0) {
      // Nothing safe within bounds. Try the hard cap before giving up.
      return tryHardCapFallback(text);
    }

    // 3. Within [0, upperBound), prefer the highest of: last closing fence,
    //    last blank line, last end-of-list-block, last heading end, last
    //    sentence end. Each list is sorted, so this is a binary search.
    const candidates = [
      highestAtMost(this.closingFenceCandidates, upperBound),
      this.findLastBlankLine(upperBound),
      highestAtMost(this.listBlockEndCandidates, upperBound),
      highestAtMost(this.headingEndCandidates, upperBound),
      highestAtMost(this.sentenceEndCandidates, upperBound),
      this.findLastSentenceEndBeforeBlank(text, upperBound),
      this.findListBlockEndAtPartialLine(partialLine, upperBound),
    ].filter((offset): offset is number => offset !== null);

    // When there's an open structure, the floor itself is a valid candidate:
    // by construction, text[floor - 1] === '\n' (open structures match at the
    // start of a line), so floor is a safe line boundary.
    if (hasOpenStructure) {
      candidates.push(upperBound);
    }

    if (candidates.length === 0) {
      return tryHardCapFallback(text);
    }

    const split = Math.max(...candidates);

    // 4. Reject splits that fall inside an inline run (`...`, **...**, *...*,
    //    _..._, [...](...)). Scanning the prefix is O(split), but it only runs
    //    when a candidate exists — i.e. right before promoting those same
    //    `split` chars out of the buffer — so it is amortized O(1) per char.
    if (isInsideInlineRun(text, split)) {
      return tryHardCapFallback(text);
    }

    return split;
  }

  /**
   * Fold every line that has gained its terminating newline since the last
   * call into the candidate lists and the fence/list state.
   */
  private commitCompletedLines(text: string): void {
    let lineStart = this.committedLength;
    let newlineIndex = text.indexOf("\n", lineStart);
    while (newlineIndex !== -1) {
      this.commitLine(text.slice(lineStart, newlineIndex), lineStart, newlineIndex);
      lineStart = newlineIndex + 1;
      newlineIndex = text.indexOf("\n", lineStart);
    }
    this.committedLength = lineStart;
  }

  /**
   * `line` excludes its newline; `lineEnd` is the offset of that newline, so
   * `lineEnd + 1` is both the start of the next line and the split candidate
   * any rule matching this line implies.
   */
  private commitLine(line: string, lineStart: number, lineEnd: number): void {
    const nextLineStart = lineEnd + 1;

    // This line is what follows the previous line's sentence end, so it
    // settles which list that candidate belongs in.
    if (this.unclassifiedSentenceEnd !== null) {
      if (line.length === 0) {
        this.sentenceEndBeforeBlankCandidates.push(this.unclassifiedSentenceEnd);
      } else {
        this.sentenceEndCandidates.push(this.unclassifiedSentenceEnd);
      }
      this.unclassifiedSentenceEnd = null;
    }

    const fenceMarker = matchFenceMarker(line);
    if (fenceMarker !== null) {
      if (this.openFenceMarker === null) {
        this.openFenceMarker = fenceMarker;
        this.openFenceStart = lineStart;
      } else if (this.openFenceMarker === fenceMarker) {
        this.openFenceMarker = null;
        this.openFenceStart = null;
      }
      // Mismatched closer: leave the open fence state unchanged.
    }

    // A `\`\`\`\n` or `~~~\n` run can only sit at the end of a line.
    if (FENCE_MARKERS.some((marker) => line.endsWith(marker))) {
      this.closingFenceCandidates.push(nextLineStart);
    }

    // An empty committed line means text[lineStart - 1] and text[lineStart]
    // are both newlines — a `\n\n` occurrence starting at lineStart - 1.
    if (line.length === 0 && lineStart > 0) {
      this.blankLineStarts.push(lineStart - 1);
    }

    if (isHeadingLine(line)) {
      this.headingEndCandidates.push(nextLineStart);
    }

    if (SENTENCE_TERMINATORS.some((terminator) => line.endsWith(terminator))) {
      this.unclassifiedSentenceEnd = nextLineStart;
    }

    const lineIsList = isListLine(line);

    // A list block ends when a list line is immediately followed by a
    // non-list, non-blank line.
    if (this.lastCommittedLineIsList && !lineIsList && line.length > 0) {
      this.listBlockEndCandidates.push(lineStart);
    }

    if (lineIsList) {
      const runStart =
        this.lastCommittedLineIsList && this.runStartOfLastCommittedLine !== null
          ? this.runStartOfLastCommittedLine
          : lineStart;
      this.runStartOfLastCommittedLine = runStart;
      this.lastListRunStart = runStart;
      this.lastListLineEnd = lineEnd;
    } else {
      this.runStartOfLastCommittedLine = null;
    }
    this.lastCommittedLineIsList = lineIsList;
  }

  /**
   * Earliest offset still inside an unclosed structure. Split must be ≤ this.
   * For text with no open structures, returns text.length.
   */
  private computeOpenStructureFloor(text: string, partialLine: string): number {
    // Open fenced code block: the last unmatched ``` (or ~~~) line, including
    // one that has just arrived in the still-unterminated partial line.
    const partialFenceMarker = matchFenceMarker(partialLine);
    if (partialFenceMarker !== null) {
      if (this.openFenceMarker === null) return this.committedLength;
      if (this.openFenceMarker !== partialFenceMarker) return this.openFenceStart ?? text.length;
      // The partial line closes the open fence.
    } else if (this.openFenceStart !== null) {
      return this.openFenceStart;
    }

    // Open list block: a list line whose continuation hasn't broken yet.
    const openListStart = this.findOpenListStart(text, partialLine);
    if (openListStart !== null) return openListStart;

    return text.length;
  }

  /**
   * Start of the last contiguous list block when that block is still "open" —
   * its last line reaches into the trailing SOFT_TAIL, so more items may
   * still arrive. The partial line counts as part of the block.
   */
  private findOpenListStart(text: string, partialLine: string): number | null {
    let blockStart: number | null;
    let blockLastLineEnd: number;

    if (isListLine(partialLine)) {
      blockStart =
        this.lastCommittedLineIsList && this.runStartOfLastCommittedLine !== null
          ? this.runStartOfLastCommittedLine
          : this.committedLength;
      blockLastLineEnd = text.length;
    } else {
      blockStart = this.lastListRunStart;
      blockLastLineEnd = this.lastListLineEnd;
    }

    if (blockStart === null) return null;
    return blockLastLineEnd >= text.length - SOFT_TAIL ? blockStart : null;
  }

  /**
   * A sentence end that a blank line follows is only a split point when the
   * bound lands exactly on it — past that, the blank-line rule owns the
   * boundary. The last committed line's candidate is still unclassified, so
   * resolve it here against the char that actually follows it.
   */
  private findLastSentenceEndBeforeBlank(text: string, upperBound: number): number | null {
    if (this.unclassifiedSentenceEnd !== null && this.unclassifiedSentenceEnd <= upperBound) {
      const candidate = this.unclassifiedSentenceEnd;
      if (text[candidate] !== "\n" || candidate === upperBound) return candidate;
    }
    const beforeBlank = highestAtMost(this.sentenceEndBeforeBlankCandidates, upperBound);
    return beforeBlank === upperBound ? beforeBlank : null;
  }

  /**
   * The end-of-list-block candidate that the still-unterminated partial line
   * closes: the last committed line is a list item and the line now streaming
   * in is not. Without this, a list followed by a long in-flight paragraph
   * would offer no split at all until that paragraph's newline arrived.
   */
  private findListBlockEndAtPartialLine(partialLine: string, upperBound: number): number | null {
    if (!this.lastCommittedLineIsList) return null;
    if (this.committedLength >= upperBound) return null;
    if (partialLine.length === 0) return null;
    if (isListLine(partialLine.slice(0, LIST_MARKER_PROBE))) return null;
    return this.committedLength;
  }

  /**
   * Highest blank-line candidate at or below `upperBound`.
   *
   * Mirrors a `lastIndexOf("\n\n", upperBound - 1)` search: the occurrence is
   * chosen first and only then checked against the bound, so an occurrence
   * starting at exactly `upperBound - 1` yields no candidate rather than
   * falling back to an earlier blank line.
   */
  private findLastBlankLine(upperBound: number): number | null {
    const occurrence = highestAtMost(this.blankLineStarts, upperBound - 1);
    if (occurrence === null) return null;
    const candidate = occurrence + 2;
    return candidate <= upperBound ? candidate : null;
  }
}

/** Highest value in a sorted ascending array that is ≤ `bound`, or null. */
function highestAtMost(sorted: readonly number[], bound: number): number | null {
  let low = 0;
  let high = sorted.length - 1;
  let best: number | null = null;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = sorted[mid]!;
    if (value <= bound) {
      best = value;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function matchFenceMarker(line: string): string | null {
  for (const marker of FENCE_MARKERS) {
    if (line.startsWith(marker)) return marker;
  }
  return null;
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]\s|\d+\.\s)/.test(line);
}

/**
 * True when the text is "still inside" a markdown structure that should be
 * rendered as a unit (code fence, table) rather than progressively chunk-by-chunk.
 *
 * Used by the streaming renderer for adaptive buffering: when streamed text
 * ends inside an open structure, the renderer defers the next live-area flush
 * (up to a cap) so partial tables and code blocks don't render incrementally
 * with shifting column widths or syntax-highlighting reflow.
 *
 * Conservative — false positives just mean the live area updates a beat later
 * than the baseline cadence; false negatives let partial structures render.
 */
export function isInsideOpenStructure(text: string): boolean {
  // Open fenced code block?
  if (findLastUnmatchedFenceStart(text) !== null) return true;

  // Open table: the last non-empty line looks like a table row (`| ... |`),
  // and we haven't yet seen the next line (no trailing newline → row is in
  // flight). Plain `|` characters in normal prose don't trip this — we
  // require the line to *start* with a pipe.
  const lastNewlineIndex = text.lastIndexOf("\n");
  const lastLine = lastNewlineIndex === -1 ? text : text.slice(lastNewlineIndex + 1);
  if (lastLine.trimStart().startsWith("|")) return true;

  return false;
}

/**
 * Find the start of the last unclosed fenced code block (``` or ~~~), or null
 * if all fences are matched.
 */
function findLastUnmatchedFenceStart(text: string): number | null {
  const fenceRegex = /^(```|~~~)/gm;
  let openFenceChar: string | null = null;
  let lastOpenStart: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (openFenceChar === null) {
      openFenceChar = match[1]!;
      lastOpenStart = match.index;
    } else if (match[1] === openFenceChar) {
      // Matched closer — clear open state.
      openFenceChar = null;
      lastOpenStart = null;
    }
    // Mismatched closer: leave openFenceChar/lastOpenStart unchanged.
  }
  return lastOpenStart;
}

/** How far back from the cap to search for a whitespace boundary before giving up. */
const HARD_CAP_WHITESPACE_SEARCH_WINDOW = 500;

function tryHardCapFallback(text: string): number {
  if (text.length <= MAX_PENDING_TAIL) return 0;

  // Prefer a newline at or before the cap.
  const newlineIndex = text.lastIndexOf("\n", MAX_PENDING_TAIL);
  if (newlineIndex !== -1) return newlineIndex + 1;

  // No newline within the cap. Walk back from the cap looking for a
  // whitespace boundary so we don't split mid-word.
  const searchFloor = Math.max(0, MAX_PENDING_TAIL - HARD_CAP_WHITESPACE_SEARCH_WINDOW);
  for (let index = MAX_PENDING_TAIL; index > searchFloor; index--) {
    const character = text[index];
    if (character === " " || character === "\t") return index + 1;
  }

  // Pathological: no newline and no whitespace within the search window
  // (e.g. a long URL or base64 blob). Cut at the cap anyway so the pending
  // buffer stays bounded — a cosmetic mid-token break beats unbounded growth.
  return MAX_PENDING_TAIL;
}

/**
 * True if `offset` falls inside an unclosed inline span (`code`, **bold**, _italic_,
 * [link](url)). Conservative: only checks the prefix up to `offset`.
 */
function isInsideInlineRun(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);

  // Inline code: count backticks not preceded by a backslash.
  const backticks = (prefix.match(/(?<!\\)`/g) ?? []).length;
  if (backticks % 2 === 1) return true;

  // Bold (**): count unmatched markers, use simple parity heuristic.
  const doubleStars = (prefix.match(/\*\*/g) ?? []).length;
  if (doubleStars % 2 === 1) return true;

  // Single-star italic: count `*` not preceded by `*` and not part of `**`.
  // Strip `**` pairs first to avoid double-counting.
  const prefixWithoutDoubleStars = prefix.replace(/\*\*/g, "");
  const singleStars = (prefixWithoutDoubleStars.match(/\*/g) ?? []).length;
  if (singleStars % 2 === 1) return true;

  // Italic underscores: count unmatched `_` markers in word boundaries.
  const underscores = (prefix.match(/(?<![A-Za-z0-9])_/g) ?? []).length;
  if (underscores % 2 === 1) return true;

  // Link in flight: an unclosed `[` without a matching `]`.
  const openBrackets = (prefix.match(/\[/g) ?? []).length;
  const closeBrackets = (prefix.match(/\]/g) ?? []).length;
  if (openBrackets > closeBrackets) return true;

  // Link with brackets closed but parens still open: `[label](http`.
  const openParens = (prefix.match(/\]\(/g) ?? []).length;
  const closeAfterOpen = countMatchedLinkParens(prefix);
  if (openParens > closeAfterOpen) return true;

  return false;
}

function countMatchedLinkParens(prefix: string): number {
  // Count `](...)` patterns that are fully closed.
  return (prefix.match(/\]\([^)]*\)/g) ?? []).length;
}
