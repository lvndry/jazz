import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { emojify } from "node-emoji";
import wrapAnsi from "wrap-ansi";
import { codeColor, CHALK_THEME, PADDING_BUDGET, THEME } from "../ui/theme";

/**
 * Shared markdown formatting utilities for terminal output.
 * Used by both cli-renderer.ts (streaming) and markdown-ansi.ts (static).
 */

/**
 * Wrap displayed text with an OSC 8 terminal hyperlink so the URL is embedded
 * as metadata. Modern terminals (Warp, iTerm2, Kitty, etc.) render the text as
 * a single clickable link even when it soft-wraps across lines.
 *
 * Format: \e]8;params;URI\e\\ DISPLAYED_TEXT \e]8;;\e\\
 */
function terminalHyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Placeholder constants using Unicode private use area to avoid markdown conflicts
const CODE_BLOCK_PLACEHOLDER_START = "\uE000";
const CODE_BLOCK_PLACEHOLDER_END = "\uE001";
const INLINE_CODE_PLACEHOLDER_START = "\uE002";
const INLINE_CODE_PLACEHOLDER_END = "\uE003";
const TASK_LIST_MARKER = "\uE004";
const LINK_PLACEHOLDER_START = "\uE005";
const LINK_PLACEHOLDER_END = "\uE006";
const FILE_PATH_LINE_PLACEHOLDER_START = "\uE007";
const FILE_PATH_LINE_PLACEHOLDER_END = "\uE008";

// Pre-compiled regexes for performance - avoid creating RegExp in hot paths

/** Matches SGR escape sequences (\x1b[…m) and OSC 8 hyperlinks (\x1b]8;…\x07). */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g;
const BLANK_LINES_REGEX = /\n{3,}/g;
const ESCAPED_TEXT_REGEX = /\\([*_`\\[\]()#+\-.!])/g;
const STRIKETHROUGH_REGEX = /~~([^~\n]+?)~~/g;
/** Matches **bold** or __bold__. Each branch only rejects its own delimiter inside the content. */
const BOLD_REGEX = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g;
const ITALIC_ASTERISK_REGEX = /(?<!\*)\*([^*\n]+?)\*(?!\*)/g;
const ITALIC_UNDERSCORE_REGEX = /(?<!_)_([^_\n]+?)_(?!_)/g;
const INLINE_CODE_REGEX = /`([^`\n]+?)`/g;
/**
 * ATX headings: CommonMark allows 0–3 spaces before `#`; models often indent further
 * (e.g. under a list). We strip any leading spaces/tabs so those lines still format
 * as headings and align with the rest of the response. (Fenced code uses separate
 * extraction, so `##` inside a code block is unaffected.)
 */
const H4_REGEX = /^[ \t]*####\s+(.+)$/gm;
const H3_REGEX = /^[ \t]*###\s+(.+)$/gm;
const H2_REGEX = /^[ \t]*##\s+(.+)$/gm;
const H1_REGEX = /^[ \t]*#\s+(.+)$/gm;
const BLOCKQUOTE_REGEX = /^\s*>\s+(.+)$/gm;
const TASK_LIST_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+)$/gm;
/** Requires 3+ of the *same* rule character (-, *, or _) via backreference. */
const HORIZONTAL_RULE_REGEX = /^\s*([-*_])\1{2,}\s*$/gm;
/** Matches [text](url) with support for one level of balanced parentheses in the URL. Excludes ANSI escapes. */
// eslint-disable-next-line no-control-regex
const LINK_REGEX = /(?<!\u001b)\[([^\]]+)\]\(([^()\s]*(?:\([^()]*\))[^()\s]*|[^)]*?)\)/g;
/**
 * Matches bare file/folder paths: absolute, ~/home, or ./relative.
 * Lookbehinds prevent matching inside URLs (char before is :, word char, or /)
 * and markdown link targets (preceded by `](`).
 * Absolute paths require at least /segment (not bare /).
 * Relative paths require an explicit ./ or ../ prefix to avoid false positives like "and/or".
 */
const FILE_PATH_REGEX =
  /(?<!\]\()(?<![:\w/])(\/(?!\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+|~(?:\/[a-zA-Z0-9._-]+)+|\.\.?\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+)/g;
/**
 * Matches absolute or ~/home paths with :line or :line:col suffix.
 * Same lookbehind guards as FILE_PATH_REGEX.
 */
const FILE_PATH_LINE_REGEX =
  /(?<!\]\()(?<![:\w/])(\/(?!\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+:\d+(?::\d+)?|~(?:\/[a-zA-Z0-9._-]+)+:\d+(?::\d+)?)/g;
/** Matches bare URLs. Trailing punctuation (.,;:!?) is excluded unless followed by a non-space char. */
const BARE_URL_REGEX =
  // eslint-disable-next-line no-control-regex
  /(?<!\]\()(https?:\/\/[^\s<>"{}|\\^`[\]\u001b]+[^\s<>"{}|\\^`[\].,;:!?)'\]\u001b]|www\.[^\s<>"{}|\\^`[\]\u001b]+[^\s<>"{}|\\^`[\].,;:!?)'\]\u001b])/g;
/** Matches fenced code blocks. Anchored to line boundaries so inline triple-backticks are not extracted. */
const CODE_BLOCK_EXTRACT_REGEX = /^[ \t]*```[\s\S]*?^[ \t]*```/gm;
const INLINE_CODE_EXTRACT_REGEX = /`([^`\n]+?)`/g;
// LINK_REGEX is reused for the extract/restore cycle (see extractLinks).
const EMOJI_SHORTCODE_REGEX = /:([A-Za-z0-9_\-+]+?):/g;
/**
 * Bold styling for **bold** text. Uses the theme's primary accent so it
 * visibly pops against body text on both light and dark terminals — the
 * previous near-white (#F8FAFC) was indistinguishable from default body
 * text on most dark themes, especially in `hybrid` display mode where the
 * `**` markers stay visible alongside the styled inner text.
 */
const EMPHASIS_BRIGHT = chalk.bold.hex(THEME.primary);
/**
 * Heading styles with deliberate weight/decoration variation so that H1–H4
 * are visually distinguishable beyond color alone (terminals don't render
 * font sizes — we have to fake hierarchy via weight, underline, and bullet).
 *
 * Hierarchy: H1 is bold + underline + warm primary; H2 is bold + agent
 * accent; H3 is bold + link blue; H4 is dim/non-bold + secondary so it
 * reads as the smallest level.
 */
const HEADING_PRIMARY = chalk.bold.underline.hex(THEME.primary);
const HEADING_AGENT = CHALK_THEME.agentBold;
const HEADING_LINK = chalk.hex(THEME.link).bold;
/**
 * H4 intentionally not bold so readers feel a weight drop from H3 → H4 even
 * without font-size changes.
 */
const HEADING_MUTED = chalk.dim.hex(THEME.secondary);
const ITALIC_MUTED = chalk.italic.hex(THEME.secondary);

/**
 * Streaming state for progressive markdown formatting
 */
export interface StreamingState {
  readonly isInCodeBlock: boolean;
}

/**
 * Result of progressive formatting
 */
export interface FormattingResult {
  readonly formatted: string;
  readonly state: StreamingState;
}

/**
 * Initial streaming state
 */
export const INITIAL_STREAMING_STATE: StreamingState = { isInCodeBlock: false };

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * Convert HTML `<br>` tags (any common variant) to real newlines.
 *
 * Markdown source typically can't express line breaks in contexts like
 * table cells, so models reach for `<br>` / `<br/>` / `<br />`. Without
 * this pass, those tags render as literal text, inflating cell widths
 * and confusing readers. We treat them as a hard line break.
 */
export function convertHtmlLineBreaks(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n");
}

/**
 * SGR codes that act as resets for the styles we layer (color, bold, italic,
 * underline, inverse, strikethrough). Any of these inside a span wrapped by
 * an outer style will cancel that outer style. We re-emit the outer's open
 * codes immediately after each match so the outer survives.
 */
// eslint-disable-next-line no-control-regex
const RESET_RE = /\x1b\[0m|\x1b\[(?:22|23|24|27|29|39|49)m/g;

/**
 * Wrap `text` (which may contain its own ANSI escapes) in an outer chalk
 * style, in a way that survives inner resets.
 *
 * Plain `chalk.red(textWithBoldAlready)` produces `\x1b[31m...\x1b[22m...\x1b[39m`
 * — the inner `\x1b[22m` from the bold close also kills the red. After this
 * helper, every inner reset is followed by a re-emit of the outer's open
 * codes so the outer color (and weight) carry through to the next reset.
 */
function wrapPreservingInner(text: string, outer: chalk.Chalk): string {
  // Probe the outer style's open and close sequences by wrapping a sentinel.
  // Sentinel uses a PUA char that won't appear in real content.
  const SENTINEL = "";
  const probed = outer(SENTINEL);
  const parts = probed.split(SENTINEL);
  const open = parts[0] ?? "";
  const close = parts[1] ?? "";
  if (open.length === 0) return text;
  // Re-emit `open` after each inner reset so the outer style survives.
  const restored = text.replace(RESET_RE, (match) => match + open);
  return open + restored + close;
}

/**
 * Normalize excessive blank lines (3+ → 2)
 */
export function normalizeBlankLines(text: string): string {
  return text.replace(BLANK_LINES_REGEX, "\n\n");
}

/**
 * Remove escape characters from markdown escaped text
 */
export function formatEscapedText(text: string): string {
  return text.replace(ESCAPED_TEXT_REGEX, "$1");
}

/**
 * Format markdown strikethrough text
 */
export function formatStrikethrough(text: string): string {
  return text.replace(STRIKETHROUGH_REGEX, (_match: string, content: string) =>
    chalk.strikethrough(content),
  );
}

/**
 * Format markdown bold text (** or __)
 */
export function formatBold(text: string): string {
  return text.replace(
    BOLD_REGEX,
    (_match: string, asteriskContent: string | undefined, underscoreContent: string | undefined) =>
      EMPHASIS_BRIGHT((asteriskContent ?? underscoreContent)!),
  );
}

// ============================================================================
// Tables — GitHub-flavored markdown
// ============================================================================

/** Border / separator chalk style. Subtle so it doesn't compete with content. */
const TABLE_BORDER = chalk.hex(THEME.secondary).dim;
/** Header cell style. Bold + accent color so headers stand out from body rows. */
const TABLE_HEADER_CELL = chalk.bold.hex(THEME.primary);

/**
 * Visible-character width of a string, ignoring ANSI escape codes.
 *
 * Conservative implementation: counts code units, which is correct for ASCII
 * and Latin-1 but slightly over-counts for some CJK / emoji glyphs. Used only
 * for column alignment, where small drift is preferable to depending on a
 * full Unicode east-asian-width table.
 */
function visibleWidth(text: string): number {
  return stripAnsiCodes(text).length;
}

/** Pad ANSI-formatted text on the right to a target visible width. */
function padRight(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/** Pad ANSI-formatted text on the LEFT to a target visible width. */
function padLeft(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return text;
  return " ".repeat(width - visible) + text;
}

/** Pad ANSI-formatted text on BOTH sides to center it within a target width. */
function padCenter(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return text;
  const total = width - visible;
  const left = Math.floor(total / 2);
  const right = total - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

type ColumnAlign = "left" | "center" | "right";

/**
 * Test whether a line looks like a markdown table alignment row.
 * Examples: `|---|---|`, `|:---|---:|`, `| :--- | ---: | :---: |`
 */
function isAlignmentRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  // Each cell must be /[\s:-]+/ with at least one dash.
  return /^\|(?:\s*:?-+:?\s*\|)+$/.test(trimmed);
}

/**
 * Parse the alignment row into per-column alignment markers.
 * `:---`  → left, `---:` → right, `:---:` → center, `---` → left (default).
 */
function parseAlignmentRow(line: string): ColumnAlign[] {
  const inner = line.trim().slice(1, -1);
  return inner.split("|").map((cell) => {
    const c = cell.trim();
    const startsColon = c.startsWith(":");
    const endsColon = c.endsWith(":");
    if (startsColon && endsColon) return "center";
    if (endsColon) return "right";
    return "left";
  });
}

/** Test whether a line looks like a markdown table row. */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 3;
}

/**
 * Split a table row line into cell contents.
 *
 * - Strips the leading and trailing pipes and splits on unescaped `|`.
 * - Converts HTML `<br>` (any common variant) to a real newline so cells
 *   can have multi-line content. Markdown tables can't span source lines,
 *   so `<br>` is the standard way to express line breaks within a cell.
 *
 * (We don't support `\|` escapes for literal pipes inside a cell because
 * models rarely emit them; if needed later, swap split for a regex.)
 */
function parseTableRow(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  return inner.split("|").map((cell) => cell.trim().replace(/<br\s*\/?>/gi, "\n"));
}

/**
 * Detect and render markdown tables to box-drawn ASCII art.
 *
 * Handles:
 *   - alignment row markers (`:---`, `---:`, `:---:`)
 *   - `<br>` line breaks inside cells (converted to `\n`)
 *   - multi-line cells (rendered as multi-line rows with vertical borders
 *     spanning every line so the table reads as a single visual unit)
 *   - cell contents pre-styled with ANSI escapes (column widths measured
 *     against visible characters)
 *   - terminal-width capping: if the natural table is wider than the
 *     available width, columns are scaled proportionally and content is
 *     soft-wrapped via wrap-ansi so borders don't overflow and break.
 *
 * Falls through unchanged when a candidate block lacks the header +
 * alignment row pair, so non-table use of `|` survives.
 */
export function formatTables(text: string): string {
  if (!text.includes("|")) return text;

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i];
    const alignLine = lines[i + 1];
    if (
      headerLine !== undefined &&
      alignLine !== undefined &&
      isTableRow(headerLine) &&
      isAlignmentRow(alignLine)
    ) {
      const headerCells = parseTableRow(headerLine);
      const aligns = parseAlignmentRow(alignLine);
      const bodyRows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!)) {
        bodyRows.push(parseTableRow(lines[j]!));
        j++;
      }

      if (headerCells.length > 0) {
        out.push(renderTable(headerCells, bodyRows, aligns));
        i = j;
        continue;
      }
    }

    out.push(headerLine ?? "");
    i++;
  }

  return out.join("\n");
}

/** Per-table layout overhead (border pipes + cell side padding). */
function tableOverhead(colCount: number): number {
  // Layout: │ <cell> │ <cell> │ <cell> │
  // = 1 (left border) + colCount * (1 padding + content + 1 padding) + (colCount - 1) inner pipes + 1 (right border)
  // Per col: 2 (padding) + 1 (separator pipe to next, except last)
  // Total non-content: 1 + 1 + (colCount - 1) + 2 * colCount = 2 * colCount + colCount + 1 = 3 * colCount + 1.
  // Wait that double-counts. Re-derive:
  //   pipes: colCount + 1
  //   side padding inside each cell: colCount * 2
  // Total = 3 * colCount + 1.
  return 3 * colCount + 1;
}

/**
 * Compute final column widths.
 *
 * Step 1: intrinsic — the longest visible-line width in each column,
 * across header + body, taking multi-line cells into account.
 *
 * Step 2: cap — if total > available terminal width, scale columns
 * proportionally to their intrinsic width, with a floor of MIN_COL_WIDTH
 * so each column is still readable. The scaled total may exceed the
 * available width slightly (due to MIN_COL_WIDTH floors) — the terminal
 * will wrap, but borders stay intact within each column.
 */
function computeColumnWidths(
  headerCells: readonly string[],
  bodyRows: readonly (readonly string[])[],
  colCount: number,
  availableContentWidth: number,
): number[] {
  const MIN_COL_WIDTH = 4;

  const intrinsic = new Array(colCount).fill(0);
  const measureCell = (cell: string, c: number): void => {
    // Multi-line cells: take the widest line.
    for (const line of cell.split("\n")) {
      const w = visibleWidth(line);
      if (w > intrinsic[c]) intrinsic[c] = w;
    }
  };
  for (let c = 0; c < colCount; c++) measureCell(headerCells[c] ?? "", c);
  for (const row of bodyRows) {
    for (let c = 0; c < colCount; c++) measureCell(row[c] ?? "", c);
  }

  const total = intrinsic.reduce((s: number, w: number) => s + w, 0);
  if (total <= availableContentWidth || availableContentWidth <= 0) {
    return intrinsic.map((w: number) => Math.max(MIN_COL_WIDTH, w));
  }

  // Proportional scale-down with floor.
  const scaled = intrinsic.map((w: number) => {
    const share = (w / total) * availableContentWidth;
    return Math.max(MIN_COL_WIDTH, Math.floor(share));
  });
  return scaled;
}

/**
 * Wrap a single cell's text to fit within `width` visible columns.
 * Returns the array of resulting lines.
 *
 * Honors any pre-existing newlines in the cell (from `<br>` conversion)
 * and additionally wraps each line that's too long. Uses `wrap-ansi` with
 * `hard: true` so words longer than the column don't escape; trim is
 * disabled so leading/trailing intentional whitespace inside a cell is
 * preserved (rare but possible).
 */
function wrapCell(cell: string, width: number): string[] {
  if (width <= 0) return [cell];
  const out: string[] = [];
  for (const line of cell.split("\n")) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapAnsi(line, width, { hard: true, trim: false });
    for (const w of wrapped.split("\n")) out.push(w);
  }
  return out.length > 0 ? out : [""];
}

/**
 * Render a parsed table to a multi-line string with box-drawing borders.
 *
 * Each row may have `rowHeight > 1` lines if any cell wraps. The
 * vertical border `│` runs through every line of the row so the table
 * reads as one visual unit.
 */
function renderTable(
  header: readonly string[],
  body: readonly (readonly string[])[],
  aligns: readonly ColumnAlign[],
): string {
  const colCount = header.length;
  const overhead = tableOverhead(colCount);

  // Available width for cell content. Subtract overhead for borders +
  // padding. The PADDING_BUDGET subtracts the page/content padding the
  // outer Box already consumes, so the table never visually exceeds the
  // viewport.
  const terminalWidth = getTerminalWidth();
  const availableContentWidth = Math.max(
    colCount * 4, // floor: 4 chars per column
    terminalWidth - PADDING_BUDGET - overhead,
  );

  const widths = computeColumnWidths(header, body, colCount, availableContentWidth);

  // Precompute line styles.
  const top = TABLE_BORDER(`┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`);
  const sep = TABLE_BORDER(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`);
  const bottom = TABLE_BORDER(`└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`);
  const pipe = TABLE_BORDER("│");

  const alignCell = (text: string, idx: number): string => {
    const w = widths[idx] ?? 0;
    const a = aligns[idx] ?? "left";
    if (a === "right") return padLeft(text, w);
    if (a === "center") return padCenter(text, w);
    return padRight(text, w);
  };

  const renderRow = (cells: readonly string[], styleHeader: boolean): string[] => {
    // Wrap each cell to its column's width — produces an array of lines.
    const wrappedPerCell = cells.map((cell, idx) => {
      const lines = wrapCell(cell ?? "", widths[idx] ?? 0);
      return styleHeader ? lines.map((l) => TABLE_HEADER_CELL(l)) : lines;
    });
    const rowHeight = Math.max(...wrappedPerCell.map((c) => c.length), 1);

    const out: string[] = [];
    for (let line = 0; line < rowHeight; line++) {
      const segments = wrappedPerCell.map((cellLines, idx) => {
        const text = cellLines[line] ?? "";
        return alignCell(text, idx);
      });
      out.push(`${pipe} ${segments.join(` ${pipe} `)} ${pipe}`);
    }
    return out;
  };

  const lines: string[] = [top, ...renderRow(header, true), sep];
  for (const row of body) {
    const normalized = new Array(colCount).fill("").map((_, idx) => row[idx] ?? "");
    lines.push(...renderRow(normalized, false));
  }
  lines.push(bottom);
  return lines.join("\n");
}

/**
 * Format markdown italic text (* or _)
 */
export function formatItalic(text: string): string {
  let formatted = text;

  formatted = formatted.replace(ITALIC_ASTERISK_REGEX, (_match: string, content: string) =>
    ITALIC_MUTED(content),
  );

  formatted = formatted.replace(ITALIC_UNDERSCORE_REGEX, (_match: string, content: string) =>
    ITALIC_MUTED(content),
  );

  return formatted;
}

// ============================================================================
// Terminal-width-aware text wrapping
// ============================================================================

/**
 * Minimum width to prevent degenerate wrapping.
 */
const MIN_WRAP_WIDTH = 20;

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
 * @param text - ANSI-formatted text to wrap (handles escape codes correctly)
 * @param availableWidth - number of visible character columns available
 */
export function wrapToWidth(text: string, availableWidth: number): string {
  if (!text || text.length === 0) return text;
  const width = Math.max(availableWidth, MIN_WRAP_WIDTH);
  return wrapAnsi(text, width, { trim: false, hard: true });
}

/**
 * Get the current terminal width, with a sensible default for non-TTY.
 */
export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Consolidated "format for terminal" pipeline: wrap + pad.
 * Use this before passing text to TerminalText for consistent rendering.
 *
 * @param text - Raw or ANSI-formatted text
 * @param options.availableWidth - Width for wrapping (default: terminal width - PADDING_BUDGET)
 * @param options.padding - Leading spaces per line (default: 0)
 */
export function formatForTerminal(
  text: string,
  options?: { availableWidth?: number; padding?: number },
): string {
  if (!text || text.length === 0) return text;
  const width = options?.availableWidth ?? getTerminalWidth() - PADDING_BUDGET;
  const wrapped = wrapToWidth(text, width);
  const padding = options?.padding ?? 0;
  return padding > 0 ? padLines(wrapped, padding) : wrapped;
}

/**
 * Bake left padding into a pre-wrapped string as literal spaces.
 *
 * This avoids passing long text through Ink's Yoga layout engine (which can
 * intermittently compute incorrect narrow widths). Non-empty lines get the
 * specified number of leading spaces; empty lines are left untouched so
 * paragraph breaks render correctly.
 */
export function padLines(text: string, spaces: number): string {
  if (!text || spaces <= 0) return text;
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/**
 * Format inline code (rendered mode) — replaces backticks with styled code.
 */
export function formatInlineCode(text: string): string {
  return text.replace(INLINE_CODE_REGEX, (_match: string, code: string) => codeColor(code));
}

/**
 * Format markdown headings with ANSI colors.
 *
 * Uses `wrapPreservingInner` so that any pre-existing ANSI inside the heading
 * text (e.g. a `**bold span**` already styled by an earlier pass) does not
 * cancel the heading color when its inner reset fires. Without this, a line
 * like `### Pre **Bolded** Post` would lose the heading color on " Post".
 */
export function formatHeadings(text: string): string {
  let formatted = text;

  // H4 (####) — non-bold, dim secondary; lightest visual weight.
  formatted = formatted.replace(H4_REGEX, (_match, header) =>
    wrapPreservingInner(`· ${header}`, HEADING_MUTED),
  );

  // H3 (###) — bold link blue.
  formatted = formatted.replace(H3_REGEX, (_match, header) =>
    wrapPreservingInner(`• ${header}`, HEADING_LINK),
  );

  // H2 (##) — bold agent accent.
  formatted = formatted.replace(H2_REGEX, (_match, header) =>
    wrapPreservingInner(`▸ ${header}`, HEADING_AGENT),
  );

  // H1 (#) — bold + underline + primary; heaviest visual weight.
  formatted = formatted.replace(H1_REGEX, (_match, header) =>
    wrapPreservingInner(`◆ ${header}`, HEADING_PRIMARY),
  );

  return formatted;
}

/**
 * Format markdown blockquotes with gray color and visual bar
 */
export function formatBlockquotes(text: string): string {
  return text.replace(
    BLOCKQUOTE_REGEX,
    (_match: string, content: string) => `${CHALK_THEME.reasoning("▏")} ${ITALIC_MUTED(content)}`,
  );
}

/**
 * Format markdown task lists with checkboxes
 */
export function formatTaskLists(text: string): string {
  return text.replace(TASK_LIST_REGEX, (_match: string, checked: string, content: string) => {
    const isChecked = checked.toLowerCase() === "x";
    const checkbox = isChecked ? CHALK_THEME.success("✓") : chalk.gray("○");
    const indent = "  ";
    return `${TASK_LIST_MARKER}${indent}${checkbox} ${content}`;
  });
}

/**
 * Format markdown lists (ordered and unordered)
 */
export function formatLists(text: string): string {
  const lines = text.split("\n");
  const processedLines = lines.map((line) => {
    // Skip if already processed as task list
    if (line.startsWith(TASK_LIST_MARKER)) {
      return line.substring(TASK_LIST_MARKER.length);
    }
    // Skip if contains task list markers (already formatted)
    if (line.includes("✓") || line.includes("○")) {
      return line;
    }

    // Unordered lists (-, *, +) with nested support
    const unorderedMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (
      unorderedMatch &&
      unorderedMatch[1] !== undefined &&
      unorderedMatch[2] !== undefined &&
      unorderedMatch[3] !== undefined
    ) {
      const indent = unorderedMatch[1];
      const bullet = unorderedMatch[2];
      const content = unorderedMatch[3];
      const indentLevel = Math.floor(indent.length / 2);
      const indentStr = "  ".repeat(indentLevel + 1);
      return `${indentStr}${chalk.yellow(bullet)} ${content}`;
    }

    // Ordered lists (1., 2., etc.)
    const orderedMatch = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
    if (
      orderedMatch &&
      orderedMatch[1] !== undefined &&
      orderedMatch[2] !== undefined &&
      orderedMatch[3] !== undefined
    ) {
      const indent = orderedMatch[1];
      const number = orderedMatch[2];
      const content = orderedMatch[3];
      const indentLevel = Math.floor(indent.length / 2);
      const indentStr = "  ".repeat(indentLevel + 1);
      return `${indentStr}${chalk.yellow(number)} ${content}`;
    }

    return line;
  });

  return processedLines.join("\n");
}

/**
 * Format markdown horizontal rules
 */
export function formatHorizontalRules(text: string, terminalWidth: number = 80): string {
  const ruleLength = Math.min(terminalWidth - 4, 40);
  const rule = "─".repeat(ruleLength);
  return text.replace(HORIZONTAL_RULE_REGEX, () => chalk.gray(rule) + "\n");
}

/**
 * Strip trailing markdown bold/italic delimiters (** and __) from a URL.
 * Used when the bare-URL regex captures delimiter chars (e.g. **url**).
 */
function stripTrailingMarkdownDelimiters(s: string): string {
  return s.replace(/(\*{2}|_{2})+$/, "");
}

/**
 * Format bare URLs as clickable OSC 8 terminal hyperlinks.
 * Strips trailing markdown bold delimiters (asterisk-pairs and underscore-pairs)
 * from the matched URL so markdown-wrapped links open correctly, while
 * preserving underscore and asterisk inside legitimate URLs.
 *
 * @param styleFn - styling function for the displayed text
 */
function formatBareUrlsImpl(text: string, styleFn: (text: string) => string): string {
  return text.replace(BARE_URL_REGEX, (match: string) => {
    const cleanUrl = stripTrailingMarkdownDelimiters(match);
    const url = cleanUrl.startsWith("www.") ? `https://${cleanUrl}` : cleanUrl;
    return terminalHyperlink(styleFn(match), url);
  });
}

/** Format bare URLs (rendered mode). */
export function formatBareUrls(text: string): string {
  return formatBareUrlsImpl(text, CHALK_THEME.link);
}

/**
 * Format bare file/folder paths as links.
 * Only adds OSC 8 hyperlink for absolute or ~/ paths.
 *
 * FILE_PATH_LINE_REGEX matches are extracted into placeholders first so that
 * FILE_PATH_REGEX cannot re-match the path portion of an already-formatted
 * file:line hyperlink.
 *
 * @param styleFn - styling function for the displayed text
 */
function formatFilePathsImpl(text: string, styleFn: (text: string) => string): string {
  // 1. Extract file:line matches into placeholders
  const lineMatches: string[] = [];
  let result = text.replace(FILE_PATH_LINE_REGEX, (match: string) => {
    const idx = lineMatches.length;
    const url = pathWithLineToFileUrl(match);
    const styled = styleFn(match);
    lineMatches.push(url ? terminalHyperlink(styled, url) : styled);
    return `${FILE_PATH_LINE_PLACEHOLDER_START}${idx}${FILE_PATH_LINE_PLACEHOLDER_END}`;
  });
  // 2. Format plain paths (placeholders are safe from re-matching)
  result = result.replace(FILE_PATH_REGEX, (match: string) => {
    const url = pathToFileUrl(match);
    const styled = styleFn(match);
    return url ? terminalHyperlink(styled, url) : styled;
  });
  // 3. Restore file:line placeholders
  for (let i = 0; i < lineMatches.length; i++) {
    result = result.replace(
      `${FILE_PATH_LINE_PLACEHOLDER_START}${i}${FILE_PATH_LINE_PLACEHOLDER_END}`,
      lineMatches[i]!,
    );
  }
  return result;
}

/** Format file paths (rendered mode). */
export function formatFilePaths(text: string): string {
  return formatFilePathsImpl(text, CHALK_THEME.link);
}

/**
 * Format markdown links as clickable OSC 8 terminal hyperlinks.
 * The URL is embedded as metadata so the link stays clickable even when text wraps.
 */
export function formatLinks(text: string): string {
  return text.replace(LINK_REGEX, (_match: string, linkText: string, url: string) =>
    terminalHyperlink(CHALK_THEME.link(linkText), url),
  );
}

/**
 * Extract markdown links into placeholders so that subsequent formatters
 * (formatBareUrls, formatFilePaths) cannot match paths/URLs inside link
 * targets. Returns the modified text and an array of extracted links.
 *
 * Call {@link restoreLinks} or {@link restoreLinksHybrid} after the
 * path/URL formatters to replace placeholders with formatted hyperlinks.
 */
function extractLinks(text: string): {
  text: string;
  links: Array<{ linkText: string; url: string }>;
} {
  const links: Array<{ linkText: string; url: string }> = [];
  const replaced = text.replace(LINK_REGEX, (_match, linkText: string, url: string) => {
    const index = links.length;
    links.push({ linkText, url });
    return `${LINK_PLACEHOLDER_START}${index}${LINK_PLACEHOLDER_END}`;
  });
  return { text: replaced, links };
}

/**
 * Restore extracted links as rendered-mode terminal hyperlinks (no visible markdown syntax).
 */
function restoreLinks(text: string, links: Array<{ linkText: string; url: string }>): string {
  let result = text;
  for (let i = 0; i < links.length; i++) {
    const placeholder = `${LINK_PLACEHOLDER_START}${i}${LINK_PLACEHOLDER_END}`;
    const { linkText, url } = links[i]!;
    result = result.replace(placeholder, terminalHyperlink(CHALK_THEME.link(linkText), url));
  }
  return result;
}

/**
 * Restore extracted links as hybrid-mode terminal hyperlinks (preserves [text](url) syntax).
 */
function restoreLinksHybrid(text: string, links: Array<{ linkText: string; url: string }>): string {
  let result = text;
  for (let i = 0; i < links.length; i++) {
    const placeholder = `${LINK_PLACEHOLDER_START}${i}${LINK_PLACEHOLDER_END}`;
    const { linkText, url } = links[i]!;
    result = result.replace(
      placeholder,
      terminalHyperlink(`[${chalk.italic(CHALK_THEME.link(linkText))}](${chalk.dim(url)})`, url),
    );
  }
  return result;
}

/**
 * Apply the full inline-formatting pipeline to non-code-block text.
 *
 * 1. Extracts inline code into placeholders (so bold/italic don't corrupt `` `code` ``).
 * 2. Applies all inline formatters (emoji, escapes, bold, italic, etc.).
 * 3. Extracts markdown links, formats bare URLs / file paths, restores links.
 * 4. Restores inline code with {@link codeColor} styling.
 *
 * Used by {@link applyProgressiveFormatting} (streaming) and exported for
 * {@link markdown-service.ts}.
 */
export function formatNonCodeText(text: string): string {
  // 1. Extract inline code to protect from bold/italic/strikethrough
  const inlineCodes: string[] = [];
  let formatted = text.replace(INLINE_CODE_EXTRACT_REGEX, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // 2. Apply inline formatting (escape stripping runs AFTER code extraction so
  //    backslash escapes inside `code` are preserved)
  formatted = formatEmojiShortcodes(formatted);
  formatted = formatEscapedText(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);

  // 3. Extract links, format bare URLs/file paths, restore links
  const { text: withoutLinks, links } = extractLinks(formatted);
  formatted = formatBareUrls(withoutLinks);
  formatted = formatFilePaths(formatted);
  formatted = restoreLinks(formatted, links);

  // 4. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${i}${INLINE_CODE_PLACEHOLDER_END}`;
    formatted = formatted.replace(placeholder, codeColor(inlineCodes[i]!));
  }

  return formatted;
}

/**
 * Apply the hybrid inline-formatting pipeline to non-code-block text.
 *
 * Mirrors {@link formatMarkdownHybrid} but scoped to non-code text so it can
 * be used in progressive streaming formatters without corrupting code blocks.
 */
function formatNonCodeTextHybrid(text: string): string {
  // 1. Extract inline code to protect from bold/italic/strikethrough
  const inlineCodes: string[] = [];
  let formatted = text.replace(INLINE_CODE_EXTRACT_REGEX, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // 2. Apply inline formatting (escape stripping runs AFTER code extraction).
  //    Inline emphasis runs BEFORE headings so the heading wrapper sees
  //    already-styled inner text — `wrapPreservingInner` keeps the heading
  //    color alive across the inner emphasis's reset codes.
  formatted = formatEmojiShortcodes(formatted);
  formatted = formatEscapedText(formatted);
  formatted = formatStrikethroughHybrid(formatted);
  formatted = formatBoldHybrid(formatted);
  formatted = formatItalicHybrid(formatted);
  formatted = formatHeadingsHybrid(formatted);
  formatted = formatBlockquotesHybrid(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatTables(formatted);
  // After tables consume their cells (which may contain `<br>`), convert
  // any remaining `<br>` in prose / list items / blockquotes to a real
  // newline. Doing this AFTER formatTables means a body row like
  // `| cell with <br>break | ... |` stays on one physical line until the
  // table parser splits cells, then the per-cell parser converts the break.
  formatted = convertHtmlLineBreaks(formatted);

  // 3. Extract links, format bare URLs/file paths, restore links
  const { text: withoutLinks, links } = extractLinks(formatted);
  formatted = formatBareUrlsHybrid(withoutLinks);
  formatted = formatFilePathsHybrid(formatted);
  formatted = restoreLinksHybrid(formatted, links);

  // 4. Restore inline code (keep backticks visible)
  for (let index = 0; index < inlineCodes.length; index++) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    formatted = formatted.replace(placeholder, `\`${codeColor(inlineCodes[index]!)}\``);
  }

  return formatted;
}

/**
 * Convert emoji shortcodes (e.g. :wave:, :thumbsup:) to their unicode equivalents.
 * Uses the node-emoji library for the shortcode-to-unicode mapping.
 * Shortcodes that don't match a known emoji are left as-is.
 */
export function formatEmojiShortcodes(text: string): string {
  if (!EMOJI_SHORTCODE_REGEX.test(text)) {
    return text;
  }
  // Reset lastIndex since we used .test() above
  EMOJI_SHORTCODE_REGEX.lastIndex = 0;
  return emojify(text);
}

/**
 * Format code block content (for extracted code blocks)
 */
export function formatCodeBlockContent(codeBlock: string): string {
  const lines = codeBlock.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
      const content = line.trimStart();
      processedLines.push(leadingWhitespace + chalk.yellow(content));
    } else {
      processedLines.push(codeColor(line));
    }
  }

  return processedLines.join("\n");
}

/**
 * A contiguous run of lines that are either all inside a code block or all outside.
 */
export type CodeTextSegment = { type: "code" | "text"; lines: string[] };

/**
 * Split lines into contiguous code / non-code segments, tracking fence toggles.
 * Fence lines (```) are emitted as single-line code segments styled with chalk.yellow.
 * Code lines inside fences are styled with {@link codeColor}.
 * Text lines are left unstyled for downstream formatting.
 *
 * Returns the segments and the final code-block state.
 */
export function segmentByCodeBlocks(
  lines: string[],
  isInCodeBlock: boolean,
): { segments: CodeTextSegment[]; isInCodeBlock: boolean } {
  const segments: CodeTextSegment[] = [];
  let current: CodeTextSegment | null = null;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (current && current.lines.length > 0) segments.push(current);
      segments.push({ type: "code", lines: [chalk.yellow(line)] });
      isInCodeBlock = !isInCodeBlock;
      current = null;
    } else if (isInCodeBlock) {
      if (!current || current.type !== "code") {
        if (current && current.lines.length > 0) segments.push(current);
        current = { type: "code", lines: [] };
      }
      current.lines.push(codeColor(line));
    } else {
      if (!current || current.type !== "text") {
        if (current && current.lines.length > 0) segments.push(current);
        current = { type: "text", lines: [] };
      }
      current.lines.push(line);
    }
  }
  if (current && current.lines.length > 0) segments.push(current);

  return { segments, isInCodeBlock };
}

/**
 * Join segments back into a single string, formatting text segments with the
 * full inline pipeline and leaving code segments as-is.
 */
function formatSegments(segments: CodeTextSegment[]): string {
  return segments
    .map((seg) =>
      seg.type === "code" ? seg.lines.join("\n") : formatNonCodeText(seg.lines.join("\n")),
    )
    .join("\n");
}

function formatSegmentsHybrid(segments: CodeTextSegment[]): string {
  return segments
    .map((seg) =>
      seg.type === "code" ? seg.lines.join("\n") : formatNonCodeTextHybrid(seg.lines.join("\n")),
    )
    .join("\n");
}

/**
 * Apply progressive formatting for streaming (stateful).
 *
 * Lines inside fenced code blocks are styled with {@link codeColor} only —
 * inline formatters (bold, italic, links, etc.) are applied exclusively to
 * non-code segments so they cannot corrupt code content.
 */
export function applyProgressiveFormatting(text: string, state: StreamingState): FormattingResult {
  if (!text || text.trim().length === 0) {
    return { formatted: text, state };
  }

  // Fast path: entirely inside a code block with no fences in this chunk
  if (state.isInCodeBlock && !text.includes("```")) {
    return {
      formatted: codeColor(text),
      state: { isInCodeBlock: state.isInCodeBlock },
    };
  }

  const { segments, isInCodeBlock } = segmentByCodeBlocks(text.split("\n"), state.isInCodeBlock);

  return { formatted: formatSegments(segments), state: { isInCodeBlock } };
}

/**
 * Apply progressive formatting for streaming in hybrid mode (stateful).
 *
 * Preserves markdown syntax markers while applying styling, and keeps code
 * blocks isolated so inline formatters cannot corrupt code content.
 */
export function applyProgressiveFormattingHybrid(
  text: string,
  state: StreamingState,
): FormattingResult {
  if (!text || text.trim().length === 0) {
    return { formatted: text, state };
  }

  // Fast path: entirely inside a code block with no fences in this chunk
  if (state.isInCodeBlock && !text.includes("```")) {
    return {
      formatted: codeColor(text),
      state: { isInCodeBlock: state.isInCodeBlock },
    };
  }

  const { segments, isInCodeBlock } = segmentByCodeBlocks(text.split("\n"), state.isInCodeBlock);

  return { formatted: formatSegmentsHybrid(segments), state: { isInCodeBlock } };
}

/**
 * Format complete markdown text (stateless)
 */
export function formatMarkdown(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  let formatted = text;
  formatted = stripAnsiCodes(formatted);
  formatted = normalizeBlankLines(formatted);

  // Extract code blocks and inline code BEFORE formatEscapedText so that
  // backslash escapes inside fenced code blocks and `inline code` are preserved.
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  formatted = formatted.replace(CODE_BLOCK_EXTRACT_REGEX, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
  });

  formatted = formatted.replace(INLINE_CODE_EXTRACT_REGEX, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // Convert emoji shortcodes (after code extraction so :code: in code blocks is preserved)
  formatted = formatEmojiShortcodes(formatted);
  // Strip backslash escapes after code extraction so \* inside code blocks is preserved
  formatted = formatEscapedText(formatted);

  // Apply formatting.
  // Order matters: inline emphasis (bold, italic, strikethrough) runs
  // BEFORE headings so the heading wrapper sees already-styled inner text
  // and can use `wrapPreservingInner` to keep its outer color across each
  // inner reset. Reversing this order causes the heading color to drop off
  // after a `**bold**` span inside the heading.
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  // Tables run after everything else so cell content is fully styled.
  // Width measurement strips ANSI to keep columns aligned.
  formatted = formatTables(formatted);
  // After tables consume their cells (which may contain `<br>`), convert
  // any remaining `<br>` in prose / list items / blockquotes to a real
  // newline. Doing this AFTER formatTables means a body row like
  // `| cell with <br>break | ... |` stays on one physical line until the
  // table parser splits cells, then the per-cell parser converts the break.
  formatted = convertHtmlLineBreaks(formatted);
  // Extract markdown links into placeholders so formatBareUrls/formatFilePaths
  // cannot match paths or URLs inside link targets like [text](./path).
  const { text: withoutLinks, links } = extractLinks(formatted);
  formatted = formatBareUrls(withoutLinks);
  formatted = formatFilePaths(formatted);
  formatted = restoreLinks(formatted, links);

  // Restore inline code - use simple string replace since placeholders are unique
  for (let index = 0; index < inlineCodes.length; index++) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    formatted = formatted.replace(placeholder, codeColor(inlineCodes[index]!));
  }

  // Restore code blocks - use simple string replace since placeholders are unique
  for (let index = 0; index < codeBlocks.length; index++) {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
    const formattedBlock = formatCodeBlockContent(codeBlocks[index]!);
    formatted = formatted.replace(placeholder, formattedBlock);
  }

  return formatted;
}

// ============================================================================
// Hybrid Mode Formatting - Preserves markdown syntax while adding styling
// ============================================================================

// Hybrid regex for safe underscore handling - only match standalone underscores
// This prevents matching underscores in identifiers like hello_world
const HYBRID_ITALIC_UNDERSCORE_REGEX = /(?<=^|[\s[(])_([^_\n]+?)_(?=[\s\],.!?)]|$)/gm;

/**
 * Format bold text in hybrid mode - keeps ** markers visible
 */
export function formatBoldHybrid(text: string): string {
  return text.replace(
    BOLD_REGEX,
    (
      _match: string,
      asteriskContent: string | undefined,
      underscoreContent: string | undefined,
    ) => {
      const content = (asteriskContent ?? underscoreContent)!;
      const delimiter = asteriskContent !== undefined ? "**" : "__";
      return `${delimiter}${EMPHASIS_BRIGHT(content)}${delimiter}`;
    },
  );
}

/**
 * Format italic text in hybrid mode - keeps * markers visible
 * Only uses asterisks for safety (underscores in identifiers are common)
 */
export function formatItalicHybrid(text: string): string {
  let formatted = text;

  // Asterisk italics - safe to use
  formatted = formatted.replace(
    ITALIC_ASTERISK_REGEX,
    (_match: string, content: string) => `*${ITALIC_MUTED(content)}*`,
  );

  // Underscore italics - only match if surrounded by whitespace/punctuation
  formatted = formatted.replace(
    HYBRID_ITALIC_UNDERSCORE_REGEX,
    (_match: string, content: string) => `_${ITALIC_MUTED(content)}_`,
  );

  return formatted;
}

/**
 * Format inline code in hybrid mode - keeps backticks visible
 */
export function formatInlineCodeHybrid(text: string): string {
  return text.replace(
    INLINE_CODE_REGEX,
    (_match: string, code: string) => `\`${codeColor(code)}\``,
  );
}

/**
 * Format headings in hybrid mode — keeps `#` markers visible.
 *
 * Uses `wrapPreservingInner` for the same reason as `formatHeadings`: when
 * an earlier pass has already styled `**bold spans**` inside the heading
 * text, the inner ANSI reset must not cancel the heading color on the rest
 * of the line.
 */
export function formatHeadingsHybrid(text: string): string {
  let formatted = text;

  // H4 (####)
  formatted = formatted.replace(
    H4_REGEX,
    (_match, header) => `#### ${wrapPreservingInner(header, HEADING_MUTED)}`,
  );

  // H3 (###)
  formatted = formatted.replace(
    H3_REGEX,
    (_match, header) => `### ${wrapPreservingInner(header, HEADING_LINK)}`,
  );

  // H2 (##)
  formatted = formatted.replace(
    H2_REGEX,
    (_match, header) => `## ${wrapPreservingInner(header, HEADING_AGENT)}`,
  );

  // H1 (#)
  formatted = formatted.replace(
    H1_REGEX,
    (_match, header) => `# ${wrapPreservingInner(header, HEADING_PRIMARY)}`,
  );

  return formatted;
}

/**
 * Format blockquotes in hybrid mode - keeps > marker visible
 */
export function formatBlockquotesHybrid(text: string): string {
  return text.replace(
    BLOCKQUOTE_REGEX,
    (_match: string, content: string) => `> ${ITALIC_MUTED(content)}`,
  );
}

/**
 * Format strikethrough in hybrid mode - keeps ~~ markers visible
 */
export function formatStrikethroughHybrid(text: string): string {
  return text.replace(
    STRIKETHROUGH_REGEX,
    (_match: string, content: string) => `~~${chalk.strikethrough(content)}~~`,
  );
}

/**
 * Convert a path string to a file:// URL for terminal hyperlinks.
 * Returns null for relative paths (not clickable — impossible to resolve at click time).
 */
function pathToFileUrl(pathStr: string): string | null {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    const resolved = path.join(os.homedir(), pathStr.slice(1));
    return pathToFileURL(resolved).href;
  }
  if (path.isAbsolute(pathStr)) {
    return pathToFileURL(pathStr).href;
  }
  return null;
}

/**
 * Parse file:line or file:line:col and return file URL with line/col if present.
 */
function pathWithLineToFileUrl(match: string): string | null {
  const lineColMatch = match.match(/:(\d+)(?::(\d+))?$/);
  if (!lineColMatch) return pathToFileUrl(match);
  const pathPart = match.slice(0, match.lastIndexOf(":" + lineColMatch[1]!));
  const line = lineColMatch[1]!;
  const col = lineColMatch[2];
  const url = pathToFileUrl(pathPart);
  if (!url) return null;
  return col ? `${url}:${line}:${col}` : `${url}:${line}`;
}

function styleAsLink(text: string): string {
  return chalk.italic(CHALK_THEME.link(text));
}

/** Format file paths (hybrid mode — italic + link color). */
function formatFilePathsHybrid(text: string): string {
  return formatFilePathsImpl(text, styleAsLink);
}

/** Format bare URLs (hybrid mode — italic + link color). */
function formatBareUrlsHybrid(text: string): string {
  return formatBareUrlsImpl(text, styleAsLink);
}

/**
 * Format links in hybrid mode — shows [text](url) with both parts styled
 * (link text: underline + italic), wrapped in an OSC 8 hyperlink so the
 * entire thing is clickable.
 */
export function formatLinksHybrid(text: string): string {
  return text.replace(LINK_REGEX, (_match: string, linkText: string, url: string) =>
    terminalHyperlink(`[${chalk.italic(CHALK_THEME.link(linkText))}](${chalk.dim(url)})`, url),
  );
}

/**
 * Format code block content in hybrid mode - keeps ``` markers visible
 */
export function formatCodeBlockContentHybrid(codeBlock: string): string {
  const lines = codeBlock.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
      const content = line.trimStart();
      processedLines.push(leadingWhitespace + chalk.yellow(content));
    } else {
      processedLines.push(codeColor(line));
    }
  }

  return processedLines.join("\n");
}

/**
 * Format complete markdown text in hybrid mode (preserves syntax, adds styling)
 */
export function formatMarkdownHybrid(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  let formatted = text;
  formatted = stripAnsiCodes(formatted);
  formatted = normalizeBlankLines(formatted);

  // Extract code blocks and inline code to protect them
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  formatted = formatted.replace(CODE_BLOCK_EXTRACT_REGEX, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
  });

  formatted = formatted.replace(INLINE_CODE_EXTRACT_REGEX, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // Convert emoji shortcodes (after code extraction so :code: in code blocks is preserved)
  formatted = formatEmojiShortcodes(formatted);
  // Strip backslash escapes after code extraction so \* inside code blocks is preserved
  formatted = formatEscapedText(formatted);

  // Apply hybrid formatting (preserves syntax markers).
  // Inline emphasis runs BEFORE headings so wrapPreservingInner inside the
  // heading wrapper can keep the heading color intact across each inner
  // emphasis reset (otherwise `### **Bold** trail` loses heading color on
  // " trail").
  formatted = formatStrikethroughHybrid(formatted);
  formatted = formatBoldHybrid(formatted);
  formatted = formatItalicHybrid(formatted);
  formatted = formatHeadingsHybrid(formatted);
  formatted = formatBlockquotesHybrid(formatted);
  formatted = formatTaskLists(formatted); // Task lists can use standard formatting
  formatted = formatLists(formatted); // Lists can use standard formatting
  formatted = formatHorizontalRules(formatted);
  // Tables run last so cells already contain styled inline content.
  formatted = formatTables(formatted);
  // After tables consume their cells (which may contain `<br>`), convert
  // any remaining `<br>` in prose / list items / blockquotes to a real
  // newline. Doing this AFTER formatTables means a body row like
  // `| cell with <br>break | ... |` stays on one physical line until the
  // table parser splits cells, then the per-cell parser converts the break.
  formatted = convertHtmlLineBreaks(formatted);
  // Extract markdown links into placeholders so formatBareUrls/formatFilePaths
  // cannot match paths or URLs inside link targets like [text](./path).
  const { text: withoutLinks, links } = extractLinks(formatted);
  formatted = formatBareUrlsHybrid(withoutLinks);
  formatted = formatFilePathsHybrid(formatted);
  formatted = restoreLinksHybrid(formatted, links);

  // Restore inline code with hybrid formatting (keeps backticks)
  for (let index = 0; index < inlineCodes.length; index++) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    formatted = formatted.replace(placeholder, `\`${codeColor(inlineCodes[index]!)}\``);
  }

  // Restore code blocks with hybrid formatting (keeps ``` markers)
  for (let index = 0; index < codeBlocks.length; index++) {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
    const formattedBlock = formatCodeBlockContentHybrid(codeBlocks[index]!);
    formatted = formatted.replace(placeholder, formattedBlock);
  }

  return formatted;
}
