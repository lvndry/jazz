import wrapAnsi from "wrap-ansi";

/**
 * Terminal-output primitives still used outside the shared markdown parser
 * (`../ui/markdown/*`), which now owns all actual markdown rendering.
 */

/** Matches SGR escape sequences (\x1b[…m) and OSC 8 hyperlinks (\x1b]8;…\x07). */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g;

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * Visible-character width of a string, ignoring ANSI escape codes.
 *
 * Conservative implementation: counts code units, which is correct for ASCII
 * and Latin-1 but slightly over-counts for some CJK / emoji glyphs. Used only
 * for wrap-width measurement, where small drift is preferable to depending on
 * a full Unicode east-asian-width table.
 */
function visibleWidth(text: string): number {
  return stripAnsiCodes(text).length;
}

// ============================================================================
// Terminal-width-aware text wrapping
// ============================================================================

/**
 * Minimum width to prevent degenerate wrapping.
 */
const MIN_WRAP_WIDTH = 20;

/**
 * Matches a complete OSC 8 hyperlink span as emitted by the shared markdown
 * parser: opener `\x1b]8;;URL\x07`, the (styled) display text, and closer
 * `\x1b]8;;\x07`. Group 1 is the target URL; group 2 is the display text
 * (styling + visible text).
 */
// eslint-disable-next-line no-control-regex
const OSC8_LINK_SPAN_REGEX = /\x1b\]8;;([^\x07]*)\x07([\s\S]*?)\x1b\]8;;\x07/g;

/** Leading / trailing runs of SGR color escapes around a hyperlink's display text. */
// eslint-disable-next-line no-control-regex
const LEADING_SGR_REGEX = /^(?:\x1b\[[0-9;]*m)+/;
// eslint-disable-next-line no-control-regex
const TRAILING_SGR_REGEX = /(?:\x1b\[[0-9;]*m)+$/;

/**
 * Separators after which a long, otherwise-unbreakable URL or path may wrap.
 * Breaking here keeps the token readable while leaving it byte-for-byte intact —
 * we never truncate or relabel a link, so the visible text can never disagree
 * with where the link actually points.
 */
const URL_BREAK_AFTER = new Set("/-._~?#&=+,;@%".split(""));

/** Visible width of the final line of `text` (everything after the last newline). */
function trailingLineWidth(text: string): number {
  const lastNewline = text.lastIndexOf("\n");
  return visibleWidth(lastNewline === -1 ? text : text.slice(lastNewline + 1));
}

/**
 * Split a visible string into pieces no wider than the given per-line budgets,
 * preferring to break immediately after a URL/path separator so wraps land on
 * meaningful boundaries. Falls back to a hard character break only when a single
 * separator-free run is itself wider than the budget. Concatenating the pieces
 * reproduces the input exactly — no characters are added or removed.
 */
function splitVisibleAtSeparators(
  visible: string,
  firstWidth: number,
  restWidth: number,
): string[] {
  const chars = [...visible];
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const budget = Math.max(1, pieces.length === 0 ? firstWidth : restWidth);
    if (chars.length - start <= budget) {
      pieces.push(chars.slice(start).join(""));
      break;
    }
    const windowEnd = start + budget;
    let breakAt = -1;
    for (let position = windowEnd; position > start; position--) {
      if (URL_BREAK_AFTER.has(chars[position - 1]!)) {
        breakAt = position;
        break;
      }
    }
    if (breakAt === -1) breakAt = windowEnd;
    pieces.push(chars.slice(start, breakAt).join(""));
    start = breakAt;
  }
  return pieces;
}

/**
 * Split the display text of a hyperlink into (leading styling, visible text,
 * trailing styling). Our links style the whole URL in one span, so the visible
 * text is a single contiguous run. Returns `null` if styling is interleaved with
 * visible characters (unexpected), signalling the caller to leave the span alone.
 */
function partitionLinkDisplay(
  display: string,
): { open: string; visible: string; close: string } | null {
  let rest = display;
  const open = rest.match(LEADING_SGR_REGEX)?.[0] ?? "";
  rest = rest.slice(open.length);
  const close = rest.match(TRAILING_SGR_REGEX)?.[0] ?? "";
  rest = rest.slice(0, rest.length - close.length);
  if (stripAnsiCodes(rest) !== rest) return null;
  return { open, visible: rest, close };
}

/**
 * Pre-break over-long hyperlink spans at separator boundaries before wrapping.
 *
 * wrap-ansi hard-wraps a link's visible URL at an arbitrary column, which reads
 * as broken (`…merite-ladi` / `versification…`). Here we split any hyperlink
 * whose visible text exceeds the width into separator-aligned fragments, each
 * re-wrapped as its own complete OSC 8 hyperlink pointing at the *same,
 * untouched* target. The result is fed to wrap-ansi, which leaves the now-short
 * fragments alone. Non-link text is untouched and wraps exactly as before.
 */
function breakLongLinkSpans(text: string, width: number): string {
  OSC8_LINK_SPAN_REGEX.lastIndex = 0;
  if (!OSC8_LINK_SPAN_REGEX.test(text)) return text;
  OSC8_LINK_SPAN_REGEX.lastIndex = 0;

  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = OSC8_LINK_SPAN_REGEX.exec(text)) !== null) {
    const [span, url, display] = match;
    result += text.slice(cursor, match.index);
    cursor = match.index + span.length;

    const offset = trailingLineWidth(result);
    const parts = partitionLinkDisplay(display ?? "");
    if (parts === null || visibleWidth(display ?? "") <= width) {
      result += span;
      continue;
    }

    const firstWidth = width - offset;
    const pieces = splitVisibleAtSeparators(parts.visible, firstWidth, width);
    const target = url ?? "";
    result += pieces
      .map((piece) => `\x1b]8;;${target}\x07${parts.open}${piece}${parts.close}\x1b]8;;\x07`)
      .join("\n");
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Pre-wrap ANSI-formatted text to fit the terminal width.
 *
 * This is necessary because Ink's Yoga layout engine intermittently computes
 * incorrect (very narrow) widths for `<Text wrap="wrap">` nodes during live
 * area re-renders, causing text to wrap almost character-by-character.
 *
 * By pre-wrapping the text before passing it to Ink, we ensure correct line
 * breaks regardless of Yoga's width calculations. Ink's own `wrap="wrap"` is
 * still set as a safety net but becomes a no-op since lines are already short
 * enough to fit.
 *
 * Long hyperlinks are first pre-broken at separator boundaries (see
 * {@link breakLongLinkSpans}) so URLs wrap at `/`, `-`, `.` rather than mid-token,
 * while remaining byte-for-byte intact and clickable.
 *
 * @param text - ANSI-formatted text to wrap (handles escape codes correctly)
 * @param availableWidth - number of visible character columns available
 */
export function wrapToWidth(text: string, availableWidth: number): string {
  if (!text || text.length === 0) return text;
  const width = Math.max(availableWidth, MIN_WRAP_WIDTH);
  return wrapAnsi(breakLongLinkSpans(text, width), width, { trim: false, hard: true });
}

/**
 * Get the current terminal width, with a sensible default for non-TTY.
 */
export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}
