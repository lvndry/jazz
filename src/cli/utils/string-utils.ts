/**
 * String and text formatting utilities for CLI output.
 */

import { getGlyphs } from "../ui/glyphs";

/**
 * Get the current terminal width, defaulting to 80 if not available.
 */
export function getTerminalWidth(): number {
  try {
    return process.stdout.columns || 80;
  } catch {
    return 80;
  }
}

/**
 * Glyph-aware horizontal rule capped at `maxWidth` and at the current
 * terminal width, so separators neither wrap on narrow terminals nor look
 * stubby relative to intent on wide ones.
 */
export function separatorLine(maxWidth = 60): string {
  const width = Math.max(10, Math.min(maxWidth, getTerminalWidth() - 2));
  return getGlyphs().divider.repeat(width);
}

/**
 * The characters escape sequences are built from.
 *
 * Spelled as codes rather than as literals so this file stays plain ASCII: a raw
 * control byte in source is invisible in a diff, and an editor or terminal that
 * prints the file can swallow or reinterpret it.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BACKSLASH = String.fromCharCode(92);

/**
 * Advances past one escape sequence, returning the index just after it.
 *
 * A scanner rather than a regex, because the alternatives a correct pattern
 * needs are exactly the cases where regex escaping is at its least readable —
 * matching a literal backslash inside a template literal takes four of them,
 * and getting that count wrong fails silently or not at all depending on which
 * branch runs. Enumerating the families in code says what each one is.
 *
 * `start` points at the ESC.
 */
function skipEscapeSequence(text: string, start: number): number {
  let index = start + 1;
  const introducer = text[index];
  if (introducer === undefined) return index;

  // CSI: ESC [ , parameter and intermediate bytes, then a final byte in
  // 0x40-0x7E. Every colour chalk emits is one of these, and so are the cursor
  // and erase sequences this codebase also writes.
  if (introducer === "[") {
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return index;
  }

  // String-payload sequences: OSC, DCS, SOS, PM, APC. These run until a string
  // terminator, so the payload has to be scanned rather than length-counted.
  // OSC 8 is the one that matters most in practice: the markdown formatter
  // wraps every URL and every markdown link in one, two sequences per link.
  if (
    introducer === "]" ||
    introducer === "P" ||
    introducer === "X" ||
    introducer === "^" ||
    introducer === "_"
  ) {
    index += 1;
    while (index < text.length) {
      if (text[index] === BEL) return index + 1;
      if (text[index] === ESC && text[index + 1] === BACKSLASH) return index + 2;
      index += 1;
    }
    return index;
  }

  // Charset designators: ESC ( B and relatives, which some pagers emit. One
  // designator byte follows the introducer.
  if (
    introducer === "(" ||
    introducer === ")" ||
    introducer === "#" ||
    introducer === "*" ||
    introducer === "+"
  ) {
    return Math.min(text.length, index + 2);
  }

  // Everything left is a single byte after the ESC: ESC c, ESC 7, ESC 8, ESC =.
  return index + 1;
}

/**
 * Removes every terminal escape sequence, leaving only the characters that
 * occupy columns.
 *
 * Used both to measure visual width and to carry text styled by one renderer
 * into another that decides colour for itself. Completeness matters more than
 * it looks: a sequence left behind is worse than a wrong measurement, because
 * painted into a composited frame it becomes visible cells and the terminal
 * then eats the characters after it. That is how "Reasoning" reached the screen
 * as "easoning" — the previous pattern matched CSI only, so the OSC 8
 * hyperlinks around every link survived it.
 */
export function stripAnsiCodes(text: string): string {
  if (!text.includes(ESC)) return text;
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === ESC) {
      index = skipEscapeSequence(text, index);
      continue;
    }
    output += text[index];
    index += 1;
  }
  return output;
}

/**
 * Get the visual width of a string, ignoring ANSI escape codes.
 */
export function getVisualWidth(text: string): number {
  return stripAnsiCodes(text).length;
}

/**
 * Pad a string with spaces on the right to reach a target visual width.
 * Handles ANSI escape codes correctly.
 */
export function padRight(text: string, width: number): string {
  const visualWidth = getVisualWidth(text);
  if (visualWidth >= width) return text;
  return text + " ".repeat(width - visualWidth);
}

/**
 * Wrap a comma-separated list of items to fit within a specific width.
 */
export function wrapCommaList(items: readonly string[], width: number): string[] {
  const parts = items.slice();
  const lines: string[] = [];
  let current = "";

  for (const p of parts) {
    const next = current.length === 0 ? p : `${current}, ${p}`;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = p;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Truncate text in the middle, preserving start and end portions.
 * Useful for showing IDs or long paths while keeping recognizable parts.
 *
 * @param text - Text to truncate
 * @param max - Maximum length
 * @returns Truncated text with ellipsis in middle if needed
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  if (max <= 10) return text.slice(0, max - 1) + "…";
  const keep = max - 1;
  const left = Math.ceil(keep * 0.6);
  const right = keep - left;
  return text.slice(0, left) + "…" + text.slice(text.length - right);
}

/**
 * Truncate text at the end with ellipsis.
 *
 * @param text - Text to truncate
 * @param max - Maximum length (including ellipsis)
 * @returns Truncated text with ellipsis at end if needed
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}

/**
 * ANSI escape sequence regex pattern.
 * Matches CSI sequences like \x1b[31m, \x1b[0m, etc.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Parse a string into segments of visible text and ANSI escape sequences.
 */
interface TextSegment {
  type: "text" | "ansi";
  content: string;
}

function parseAnsiSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  ANSI_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "ansi", content: match[0] });
    lastIndex = ANSI_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments;
}

/**
 * Truncate text from the start (keeping the tail), respecting ANSI escape sequences.
 * This ensures ANSI sequences are not split and maintains proper terminal styling.
 *
 * @param text - Text to truncate
 * @param maxVisibleChars - Maximum number of visible characters to keep
 * @returns Truncated text with ANSI sequences intact
 */
export function truncateTailAnsiSafe(text: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) return "";

  const visibleLength = getVisualWidth(text);
  if (visibleLength <= maxVisibleChars) return text;

  const segments = parseAnsiSegments(text);
  const charsToSkip = visibleLength - maxVisibleChars;

  let skippedChars = 0;
  const resultSegments: TextSegment[] = [];
  let startedCollecting = false;

  for (const segment of segments) {
    if (segment.type === "ansi") {
      if (startedCollecting) {
        resultSegments.push(segment);
      }
      continue;
    }

    const textContent = segment.content;
    if (!startedCollecting) {
      const remainingToSkip = charsToSkip - skippedChars;
      if (textContent.length <= remainingToSkip) {
        skippedChars += textContent.length;
      } else {
        startedCollecting = true;
        const keptText = textContent.slice(remainingToSkip);
        if (keptText.length > 0) {
          resultSegments.push({ type: "text", content: keptText });
        }
        skippedChars = charsToSkip;
      }
    } else {
      resultSegments.push(segment);
    }
  }

  return resultSegments.map((s) => s.content).join("");
}

/**
 * Format a Date to a short ISO-like string: "YYYY-MM-DD HH:MM"
 */
export function formatIsoShort(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Format a list of tools as a summary line.
 *
 * @param tools - List of tool names
 * @param maxWidth - Maximum width for the output
 * @returns Formatted tools summary
 */
export function formatToolsLine(tools: readonly string[] | undefined, maxWidth: number): string {
  const list = tools ?? [];
  if (list.length === 0) return "tools none configured";
  const joined = list.join(", ");
  return truncateMiddle(`tools ${list.length} — ${joined}`, Math.max(20, maxWidth - 2));
}
