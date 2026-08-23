import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { emojify } from "node-emoji";
import wrapAnsi from "wrap-ansi";
import { getGlyphs, resolveGlyphMode } from "../ui/glyphs";
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

/**
 * Placeholder matchers for the extract/restore cycles below. Each placeholder is
 * `<start><decimal index><end>`, so one global regex can find every one of them.
 */
const CODE_BLOCK_PLACEHOLDER_REGEX = new RegExp(
  `${CODE_BLOCK_PLACEHOLDER_START}(\\d+)${CODE_BLOCK_PLACEHOLDER_END}`,
  "g",
);
const INLINE_CODE_PLACEHOLDER_REGEX = new RegExp(
  `${INLINE_CODE_PLACEHOLDER_START}(\\d+)${INLINE_CODE_PLACEHOLDER_END}`,
  "g",
);
const LINK_PLACEHOLDER_REGEX = new RegExp(
  `${LINK_PLACEHOLDER_START}(\\d+)${LINK_PLACEHOLDER_END}`,
  "g",
);
const FILE_PATH_LINE_PLACEHOLDER_REGEX = new RegExp(
  `${FILE_PATH_LINE_PLACEHOLDER_START}(\\d+)${FILE_PATH_LINE_PLACEHOLDER_END}`,
  "g",
);

/**
 * Restore every placeholder of one kind in a single scan.
 *
 * The per-placeholder `text.replace(placeholder, value)` loops this replaces
 * rescanned the whole document once per placeholder, which is quadratic on a
 * long reply with many code spans (a 50KB reply carries hundreds). They also
 * ran the restored value through `String.replace`'s substitution grammar, so a
 * `$&` or `$1` inside restored code expanded instead of being emitted. Passing
 * a replacer function avoids both.
 *
 * An index with no entry (impossible unless a formatter invented a placeholder)
 * is left in place rather than dropped.
 */
function restorePlaceholders(
  text: string,
  pattern: RegExp,
  render: (index: number) => string | undefined,
): string {
  return text.replace(pattern, (match: string, digits: string) => render(Number(digits)) ?? match);
}

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
/**
 * Underscore italics, matched only at word boundaries. Per CommonMark, an
 * underscore flanked by alphanumerics does NOT open or close emphasis, so
 * intraword underscores in file paths (`bail_logement_loue`) and URLs
 * (`foo_bar_baz`) are left untouched instead of being stripped. The opener must
 * follow start-of-line / whitespace / `[` / `(`; the closer must precede
 * end-of-line / whitespace / closing punctuation.
 */
const ITALIC_UNDERSCORE_REGEX = /(?<=^|[\s[(])_([^_\n]+?)_(?=$|[\s\].,!?)])/gm;
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
 * Every style below is a function that reads `THEME` when it is called.
 *
 * They used to be chalk instances built once at module load, which meant they
 * captured whichever palette was active at import and `/theme` silently left
 * them behind until the next process. Resolving per call costs nothing at this
 * frequency and makes the theme switch actually total.
 */

/**
 * Bold **text** gets weight, not a hue. Emphasis is not a semantic category —
 * it does not answer "what is this?" — and spending the accent on it would be
 * worse than the amber it replaced, because the accent means "live" everywhere
 * else in the interface. Terminals render bold as a real weight change, which
 * is the distinction being asked for.
 */
const EMPHASIS_BRIGHT = (text: string): string => chalk.bold.hex(THEME.selected)(text);

/**
 * H1–H4 as a weight ramp rather than four different hues, since terminals
 * cannot render font sizes. Only H1 spends the accent; the rest step down the
 * neutral ramp, so a heading in a response never competes with a live
 * indicator for attention.
 *
 * H1 bold + underline + accent · H2 bold + primary text · H3 bold + secondary ·
 * H4 secondary, not bold, so the weight drop from H3 is felt.
 */
const HEADING_PRIMARY = (text: string): string => chalk.bold.underline.hex(THEME.primary)(text);
const HEADING_AGENT = (text: string): string => chalk.bold.hex(THEME.selected)(text);
const HEADING_LINK = (text: string): string => chalk.bold.hex(THEME.secondary)(text);
const HEADING_MUTED = (text: string): string => chalk.hex(THEME.secondary)(text);
const ITALIC_MUTED = (text: string): string => chalk.italic.hex(THEME.secondary)(text);

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
// Only ever calls `outer`, so the parameter is typed as what it actually needs
// rather than as a chalk instance. That is what lets the styles above be plain
// functions that resolve the palette per call.
function wrapPreservingInner(text: string, outer: (value: string) => string): string {
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

/** Border / separator style. Subtle so it doesn't compete with content. */
const TABLE_BORDER = (text: string): string => chalk.hex(THEME.secondary).dim(text);
/**
 * Header cells stand out from body rows by weight. A table is chrome around
 * content, so it does not get the accent — which is reserved for live things.
 */
const TABLE_HEADER_CELL = (text: string): string => chalk.bold.hex(THEME.selected)(text);

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

  const intrinsic: number[] = new Array<number>(colCount).fill(0);
  const measureCell = (cell: string, c: number): void => {
    // Multi-line cells: take the widest line.
    for (const line of cell.split("\n")) {
      const w = visibleWidth(line);
      if (w > (intrinsic[c] ?? 0)) intrinsic[c] = w;
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
  // Most cells already fit their column, and wrap-ansi is the most expensive
  // thing table rendering does per cell. A cell with no break that measures
  // within the column comes back from wrap-ansi unchanged, so skip the call.
  if (!cell.includes("\n") && visibleWidth(cell) <= width) return [cell];
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
 * Border character set for a given table style.
 *
 * `ascii` (default) — uses only `+`, `-`, `|`. Renders identically in every
 * monospace font and terminal that's ever existed. The portable choice;
 * what we recommend unless the user has explicitly verified Unicode
 * box-drawing renders cleanly in their setup.
 *
 * `unicode` — `┌┬┐├┼┤└┴┘│─`. Looks great in modern fonts (JetBrains
 * Mono, Fira Code, MesloLGS, SF Mono) but renders broken in macOS
 * default Menlo, in some CJK locales (ambiguous-width interpretation),
 * and in any terminal whose font doesn't include U+2500 box-drawing
 * glyphs (those fall back to a different font with a different metric,
 * mis-aligning everything).
 *
 * `minimal` — no borders, just dim column separators. Lightest visual
 * weight, never wraps wrong because there's nothing to break.
 */
type TableStyle = "ascii" | "unicode" | "minimal";

interface TableChars {
  /** top-left corner */ readonly tl: string;
  /** top junction (╤) */ readonly tj: string;
  /** top-right corner */ readonly tr: string;
  /** mid-left junction */ readonly ml: string;
  /** mid junction (┼) */ readonly mj: string;
  /** mid-right junction */ readonly mr: string;
  /** bottom-left corner */ readonly bl: string;
  /** bottom junction (┴) */ readonly bj: string;
  /** bottom-right corner */ readonly br: string;
  /** vertical bar */ readonly v: string;
  /** horizontal bar */ readonly h: string;
}

const TABLE_CHARS: Record<TableStyle, TableChars> = {
  ascii: {
    tl: "+",
    tj: "+",
    tr: "+",
    ml: "+",
    mj: "+",
    mr: "+",
    bl: "+",
    bj: "+",
    br: "+",
    v: "|",
    h: "-",
  },
  unicode: {
    tl: "┌",
    tj: "┬",
    tr: "┐",
    ml: "├",
    mj: "┼",
    mr: "┤",
    bl: "└",
    bj: "┴",
    br: "┘",
    v: "│",
    h: "─",
  },
  minimal: {
    tl: "",
    tj: "",
    tr: "",
    ml: "",
    mj: "",
    mr: "",
    bl: "",
    bj: "",
    br: "",
    v: " ",
    h: "",
  },
};

/**
 * Resolve which table style to use.
 *
 * Resolution order:
 *
 *   1. `JAZZ_TABLE_STYLE` env if set to a valid value — most specific,
 *      lets users get `minimal` borderless tables without changing the
 *      rest of the UI's glyph mode.
 *   2. The active `JAZZ_UI_GLYPHS` mode — `ascii`/`unicode` map directly.
 *   3. Default `ascii` (portable).
 */
function resolveTableStyle(): TableStyle {
  const raw = (process.env["JAZZ_TABLE_STYLE"] ?? "").toLowerCase();
  if (raw === "unicode" || raw === "minimal" || raw === "ascii") return raw;
  // Inherit from the global glyph mode so a single `JAZZ_UI_GLYPHS=unicode`
  // setting flips both tables and decoration glyphs.
  return resolveGlyphMode() === "unicode" ? "unicode" : "ascii";
}

/**
 * Render a parsed table to a multi-line string.
 *
 * Each row may have `rowHeight > 1` lines if any cell wraps. The
 * vertical border runs through every line of the row so the table
 * reads as one visual unit. Border style is selected via
 * `resolveTableStyle()` — defaults to ASCII (`+` `|` `-`) for
 * font/terminal portability; users with confirmed Unicode-capable
 * setups can opt in via `JAZZ_TABLE_STYLE=unicode`.
 */
function renderTable(
  header: readonly string[],
  body: readonly (readonly string[])[],
  aligns: readonly ColumnAlign[],
): string {
  const style = resolveTableStyle();
  const c = TABLE_CHARS[style];
  const colCount = header.length;
  const overhead = tableOverhead(colCount);

  // Available width for cell content. Subtract overhead for borders +
  // padding. PADDING_BUDGET subtracts the page/content padding the outer
  // Box already consumes, so the table never visually exceeds the viewport.
  const terminalWidth = getTerminalWidth();
  const availableContentWidth = Math.max(
    colCount * 4, // floor: 4 chars per column
    terminalWidth - PADDING_BUDGET - overhead,
  );

  const widths = computeColumnWidths(header, body, colCount, availableContentWidth);

  const isMinimal = style === "minimal";

  // Border lines. For `minimal`, the top/separator/bottom rules are
  // empty — we'll filter them out before joining. For ascii/unicode they
  // span every column with junction chars.
  const buildRule = (left: string, junction: string, right: string): string => {
    const segs = widths.map((w) => c.h.repeat(w + 2));
    return TABLE_BORDER(`${left}${segs.join(junction)}${right}`);
  };
  const top = isMinimal ? "" : buildRule(c.tl, c.tj, c.tr);
  const sep = isMinimal ? "" : buildRule(c.ml, c.mj, c.mr);
  const bottom = isMinimal ? "" : buildRule(c.bl, c.bj, c.br);
  const pipe = TABLE_BORDER(c.v);

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
    const rowHeight = Math.max(...wrappedPerCell.map((line) => line.length), 1);

    const out: string[] = [];
    for (let line = 0; line < rowHeight; line++) {
      const segments = wrappedPerCell.map((cellLines, idx) => {
        const text = cellLines[line] ?? "";
        return alignCell(text, idx);
      });
      // For ascii/unicode: pipes wrap cells with single-space padding on
      // each side. For minimal: no outer pipes, dim space separator
      // between cells, no surrounding padding.
      if (isMinimal) {
        out.push(segments.join(`  `));
      } else {
        out.push(`${pipe} ${segments.join(` ${pipe} `)} ${pipe}`);
      }
    }
    return out;
  };

  const lines: string[] = [];
  if (top) lines.push(top);
  lines.push(...renderRow(header, true));
  if (sep) lines.push(sep);
  for (const row of body) {
    const normalized = new Array(colCount).fill("").map((_, idx) => row[idx] ?? "");
    lines.push(...renderRow(normalized, false));
  }
  if (bottom) lines.push(bottom);
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
 * Matches a complete OSC 8 hyperlink span as emitted by {@link terminalHyperlink}:
 * opener `\x1b]8;;URL\x07`, the (styled) display text, and closer `\x1b]8;;\x07`.
 * Group 1 is the target URL; group 2 is the display text (styling + visible text).
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
  const g = getGlyphs();

  // H4 — lightest visual weight (non-bold, dim secondary).
  formatted = formatted.replace(H4_REGEX, (_match, header) =>
    wrapPreservingInner(`${g.heading4} ${header}`, HEADING_MUTED),
  );

  // H3 — bold link blue.
  formatted = formatted.replace(H3_REGEX, (_match, header) =>
    wrapPreservingInner(`${g.heading3} ${header}`, HEADING_LINK),
  );

  // H2 — bold agent accent.
  formatted = formatted.replace(H2_REGEX, (_match, header) =>
    wrapPreservingInner(`${g.heading2} ${header}`, HEADING_AGENT),
  );

  // H1 — bold + underline + primary; heaviest visual weight.
  formatted = formatted.replace(H1_REGEX, (_match, header) =>
    wrapPreservingInner(`${g.heading1} ${header}`, HEADING_PRIMARY),
  );

  return formatted;
}

/**
 * Format markdown blockquotes with gray color and visual bar
 */
export function formatBlockquotes(text: string): string {
  return text.replace(
    BLOCKQUOTE_REGEX,
    (_match: string, content: string) =>
      `${CHALK_THEME.reasoning(getGlyphs().blockquote)} ${ITALIC_MUTED(content)}`,
  );
}

/**
 * Format markdown task lists with checkboxes
 */
export function formatTaskLists(text: string): string {
  return text.replace(TASK_LIST_REGEX, (_match: string, checked: string, content: string) => {
    const isChecked = checked.toLowerCase() === "x";
    const checkbox = isChecked ? CHALK_THEME.success("✓") : CHALK_THEME.muted("○");
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
      return `${indentStr}${codeColor(bullet)} ${content}`;
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
      return `${indentStr}${codeColor(number)} ${content}`;
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
  return text.replace(HORIZONTAL_RULE_REGEX, () => CHALK_THEME.muted(rule) + "\n");
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
  return restorePlaceholders(
    result,
    FILE_PATH_LINE_PLACEHOLDER_REGEX,
    (index) => lineMatches[index],
  );
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
  return restorePlaceholders(text, LINK_PLACEHOLDER_REGEX, (index) => {
    const link = links[index];
    return link && terminalHyperlink(CHALK_THEME.link(link.linkText), link.url);
  });
}

/**
 * Restore extracted links as hybrid-mode terminal hyperlinks (preserves [text](url) syntax).
 */
function restoreLinksHybrid(text: string, links: Array<{ linkText: string; url: string }>): string {
  return restorePlaceholders(text, LINK_PLACEHOLDER_REGEX, (index) => {
    const link = links[index];
    return (
      link &&
      terminalHyperlink(
        `[${chalk.italic(CHALK_THEME.link(link.linkText))}](${chalk.dim(link.url)})`,
        link.url,
      )
    );
  });
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
  return restorePlaceholders(formatted, INLINE_CODE_PLACEHOLDER_REGEX, (index) => {
    const code = inlineCodes[index];
    return code === undefined ? undefined : codeColor(code);
  });
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
  return restorePlaceholders(formatted, INLINE_CODE_PLACEHOLDER_REGEX, (index) => {
    const code = inlineCodes[index];
    return code === undefined ? undefined : `\`${codeColor(code)}\``;
  });
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
 * Extract a language hint from a fence line like ```ts or ```python.
 * Empty / unrecognized → null, signalling "fall back to plain code color".
 */
function extractFenceLanguage(line: string): string | null {
  const m = line.trim().match(/^```([a-zA-Z0-9+_.-]+)/);
  if (!m) return null;
  const lang = m[1]!.toLowerCase();
  return supportsLanguage(lang) ? lang : null;
}

/**
 * Memo for {@link tryHighlight}. highlight.js parsing is the single most
 * expensive thing the markdown pipeline does — ~0.1ms per fence, and the live
 * tail re-formats every completed fence in the pending reply on each render
 * tick — so identical (chalk level, language, body) triples are answered from
 * here instead of re-parsed. Keyed on chalk.level because a color-depth change
 * changes the emitted escapes.
 */
const highlightCache = new Map<string, string>();
/**
 * Bodies above this are highlighted fresh every time: caching them would let a
 * single pasted-file-sized fence pin megabytes for the life of the process.
 */
const HIGHLIGHT_CACHE_MAX_BODY_CHARS = 8 * 1024;
/**
 * Room for every fence in a long reply (a 50KB reply carries ~80) plus the
 * handful of earlier replies the transcript may re-render.
 */
const HIGHLIGHT_CACHE_MAX_ENTRIES = 256;

/**
 * Apply syntax highlighting to a code block body using `cli-highlight`.
 *
 * Returns the highlighted source on success, or `null` if highlighting
 * fails (unknown grammar, malformed input, etc.) so callers can fall back
 * to the plain-color path. We never throw out of this — markdown rendering
 * must remain best-effort.
 */
function tryHighlight(body: string, language: string): string | null {
  const cacheKey = `${String(chalk.level)}\u0000${language}\u0000${body}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency so a fence the live tail keeps re-rendering stays warm.
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }

  let highlighted: string | null;
  try {
    highlighted = highlight(body, { language, ignoreIllegals: true });
  } catch {
    highlighted = null;
  }

  if (highlighted !== null && body.length <= HIGHLIGHT_CACHE_MAX_BODY_CHARS) {
    if (highlightCache.size >= HIGHLIGHT_CACHE_MAX_ENTRIES) {
      const oldest = highlightCache.keys().next();
      if (!oldest.done) highlightCache.delete(oldest.value);
    }
    highlightCache.set(cacheKey, highlighted);
  }
  return highlighted;
}

/**
 * Format code block content (for extracted code blocks).
 *
 * Detects the language from the opening fence (```ts, ```python, etc.)
 * and pipes the body through `cli-highlight` for syntax coloring. The
 * fence lines themselves stay yellow. When the language isn't specified
 * or isn't recognized by highlight.js, falls back to the previous
 * monochrome `codeColor` styling so output never regresses.
 */
export function formatCodeBlockContent(codeBlock: string): string {
  const lines = codeBlock.split("\n");
  if (lines.length === 0) return codeBlock;

  // Find the opening fence line (first line that starts with ```).
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("```")) {
      openIdx = i;
      break;
    }
  }

  if (openIdx === -1) {
    // No fence — treat the whole thing as styled body.
    return lines.map((l) => codeColor(l)).join("\n");
  }

  const language = extractFenceLanguage(lines[openIdx]!);
  // Find the closing fence (last line that starts with ```).
  let closeIdx = lines.length;
  for (let i = lines.length - 1; i > openIdx; i--) {
    if (lines[i]!.trim().startsWith("```")) {
      closeIdx = i;
      break;
    }
  }

  const bodyLines = lines.slice(openIdx + 1, closeIdx);
  const body = bodyLines.join("\n");

  let styledBody: string;
  if (language && body.length > 0) {
    const highlighted = tryHighlight(body, language);
    styledBody = highlighted ?? bodyLines.map((l) => codeColor(l)).join("\n");
  } else {
    styledBody = bodyLines.map((l) => codeColor(l)).join("\n");
  }

  const out: string[] = [];
  // Pre-fence lines (rare — usually nothing).
  for (let i = 0; i < openIdx; i++) out.push(codeColor(lines[i]!));
  // Open fence stays yellow so the markdown delimiter is visible.
  {
    const line = lines[openIdx]!;
    const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
    out.push(leadingWhitespace + codeColor(line.trimStart()));
  }
  // Highlighted body.
  if (styledBody.length > 0 || bodyLines.length > 0) {
    out.push(styledBody);
  }
  // Close fence (if present).
  if (closeIdx < lines.length) {
    const line = lines[closeIdx]!;
    const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
    out.push(leadingWhitespace + codeColor(line.trimStart()));
  }
  // Anything after the close fence (rare).
  for (let i = closeIdx + 1; i < lines.length; i++) out.push(codeColor(lines[i]!));

  return out.join("\n");
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
      segments.push({ type: "code", lines: [codeColor(line)] });
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

  // Restore inline code, then code blocks — one scan per placeholder kind.
  formatted = restorePlaceholders(formatted, INLINE_CODE_PLACEHOLDER_REGEX, (index) => {
    const code = inlineCodes[index];
    return code === undefined ? undefined : codeColor(code);
  });
  return restorePlaceholders(formatted, CODE_BLOCK_PLACEHOLDER_REGEX, (index) => {
    const block = codeBlocks[index];
    return block === undefined ? undefined : formatCodeBlockContent(block);
  });
}

// ============================================================================
// Hybrid Mode Formatting - Preserves markdown syntax while adding styling
// ============================================================================

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
    ITALIC_UNDERSCORE_REGEX,
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
    (_match: string, header: string) => `#### ${wrapPreservingInner(header, HEADING_MUTED)}`,
  );

  // H3 (###)
  formatted = formatted.replace(
    H3_REGEX,
    (_match: string, header: string) => `### ${wrapPreservingInner(header, HEADING_LINK)}`,
  );

  // H2 (##)
  formatted = formatted.replace(
    H2_REGEX,
    (_match: string, header: string) => `## ${wrapPreservingInner(header, HEADING_AGENT)}`,
  );

  // H1 (#)
  formatted = formatted.replace(
    H1_REGEX,
    (_match: string, header: string) => `# ${wrapPreservingInner(header, HEADING_PRIMARY)}`,
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
      processedLines.push(leadingWhitespace + codeColor(content));
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

  // Restore inline code (keeps backticks), then code blocks (keeps ``` markers).
  formatted = restorePlaceholders(formatted, INLINE_CODE_PLACEHOLDER_REGEX, (index) => {
    const code = inlineCodes[index];
    return code === undefined ? undefined : `\`${codeColor(code)}\``;
  });
  return restorePlaceholders(formatted, CODE_BLOCK_PLACEHOLDER_REGEX, (index) => {
    const block = codeBlocks[index];
    return block === undefined ? undefined : formatCodeBlockContentHybrid(block);
  });
}
