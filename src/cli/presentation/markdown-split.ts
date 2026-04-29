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
 */

/** Hard cap on pending tail size. Triggers a forced last-newline fallback. */
export const MAX_PENDING_TAIL = 8192;

/** Never split inside the trailing N chars — too likely to be in-flight. */
export const SOFT_TAIL = 256;

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
  if (text.length === 0) return 0;

  // 1. Compute the floor: the earliest offset still inside an open structure.
  //    Split point cannot exceed this floor.
  const floor = computeOpenStructureFloor(text);
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

  // 3. Within [0, upperBound), prefer in priority order:
  //    a. Last closing fence followed by \n.
  //    b. Last blank line (\n\n) at column 0.
  //    c. Last end-of-list-block boundary.
  //    d. Last heading line end.
  //    e. Last sentence end.
  const candidates = [
    findLastClosingFence(text, upperBound),
    findLastBlankLine(text, upperBound),
    findLastEndOfListBlock(text, upperBound),
    findLastHeadingEnd(text, upperBound),
    findLastSentenceEnd(text, upperBound),
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
  //    _..._, [...](...)).
  if (isInsideInlineRun(text, split)) {
    return tryHardCapFallback(text);
  }

  return split;
}

/**
 * Earliest offset still inside an unclosed structure. Split must be ≤ this.
 * For text with no open structures, returns text.length.
 */
function computeOpenStructureFloor(text: string): number {
  // Open fenced code block: track last unmatched ``` (or ~~~) line.
  const fenceMatch = findLastUnmatchedFenceStart(text);
  if (fenceMatch !== null) return fenceMatch;

  // Open list block: a list line whose continuation hasn't broken yet.
  const listMatch = findLastOpenListStart(text);
  if (listMatch !== null) return listMatch;

  return text.length;
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

/**
 * Find the start of the last list block whose continuation is still active —
 * i.e., the last line index `i` such that all lines from `i` onward are list
 * items or list-item continuations and there's no break.
 *
 * Conservative: any list-line touching the last SOFT_TAIL is treated as open.
 */
function isListLine(line: string): boolean {
  return /^\s*([-*+]\s|\d+\.\s)/.test(line);
}

function findLastOpenListStart(text: string): number | null {
  const lines = text.split("\n");
  const cumulative: number[] = [];
  let acc = 0;
  for (const line of lines) {
    cumulative.push(acc);
    acc += line.length + 1; // +1 for the \n
  }

  // Find the last contiguous list block.
  let lastListBlockStart: number | null = null;
  let lastListBlockEnd = -1; // exclusive
  let i = lines.length - 1;
  while (i >= 0) {
    if (isListLine(lines[i]!)) {
      let blockStart = i;
      while (blockStart > 0 && isListLine(lines[blockStart - 1]!)) {
        blockStart -= 1;
      }
      if (lastListBlockStart === null) {
        lastListBlockStart = blockStart;
        lastListBlockEnd = i + 1;
      }
      i = blockStart - 1;
    } else {
      i -= 1;
    }
  }

  if (lastListBlockStart === null) return null;

  // If the last line of the block is in the soft tail, the list is "open".
  const lastLineEnd = cumulative[lastListBlockEnd - 1]! + lines[lastListBlockEnd - 1]!.length;
  if (lastLineEnd >= text.length - SOFT_TAIL) {
    return cumulative[lastListBlockStart] ?? null;
  }
  return null;
}

function findLastClosingFence(text: string, upperBound: number): number | null {
  // Search for ```\n or ~~~\n strictly within [0, upperBound).
  const region = text.slice(0, upperBound);
  let last = -1;
  for (const marker of ["```\n", "~~~\n"] as const) {
    const idx = region.lastIndexOf(marker);
    if (idx !== -1) {
      const candidate = idx + marker.length;
      if (candidate <= upperBound) last = Math.max(last, candidate);
    }
  }
  return last === -1 ? null : last;
}

function findLastBlankLine(text: string, upperBound: number): number | null {
  const idx = text.lastIndexOf("\n\n", upperBound - 1);
  if (idx === -1) return null;
  const candidate = idx + 2;
  return candidate <= upperBound ? candidate : null;
}

function findLastEndOfListBlock(text: string, upperBound: number): number | null {
  // A list block ends when a list line is immediately followed by a non-list,
  // non-blank line. Conservative: only return the end if the end is ≤ upperBound.
  const lines = text.slice(0, upperBound).split("\n");
  let acc = 0;
  let lastEnd: number | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const here = lines[i]!;
    const next = lines[i + 1]!;
    acc += here.length + 1; // +1 for \n consumed
    if (isListLine(here) && next.length > 0 && !isListLine(next)) {
      lastEnd = acc;
    }
  }
  return lastEnd;
}

function findLastHeadingEnd(text: string, upperBound: number): number | null {
  const region = text.slice(0, upperBound);
  // ATX heading: a line beginning with one or more # followed by space.
  let lastEnd: number | null = null;
  const lines = region.split("\n");
  let acc = 0;
  for (const line of lines) {
    acc += line.length + 1;
    if (/^#{1,6}\s/.test(line)) {
      // The heading line ends after its trailing \n.
      if (acc <= upperBound) lastEnd = acc;
    }
  }
  return lastEnd;
}

function findLastSentenceEnd(text: string, upperBound: number): number | null {
  const region = text.slice(0, upperBound);
  const regex = /[.?!]\n(?=[^\n]|$)/g;
  let lastEnd: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(region)) !== null) {
    lastEnd = match.index + match[0].length;
  }
  return lastEnd;
}

function tryHardCapFallback(text: string): number {
  if (text.length <= MAX_PENDING_TAIL) return 0;
  // Find the last \n at or before MAX_PENDING_TAIL.
  const idx = text.lastIndexOf("\n", MAX_PENDING_TAIL);
  return idx === -1 ? 0 : idx + 1;
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
