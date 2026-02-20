import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { emojify } from "node-emoji";
import wrapAnsi from "wrap-ansi";
import { codeColor, CHALK_THEME } from "../ui/theme";

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
/** Headings allow 0-3 leading spaces (4+ is an indented code block per CommonMark). */
const H4_REGEX = /^[ ]{0,3}####\s+(.+)$/gm;
const H3_REGEX = /^[ ]{0,3}###\s+(.+)$/gm;
const H2_REGEX = /^[ ]{0,3}##\s+(.+)$/gm;
const H1_REGEX = /^[ ]{0,3}#\s+(.+)$/gm;
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
  /(?<!\]\()(https?:\/\/[^\s<>"{}|\\^`[\]]+[^\s<>"{}|\\^`[\].,;:!?)'\]]|www\.[^\s<>"{}|\\^`[\]]+[^\s<>"{}|\\^`[\].,;:!?)'\]])/g;
/** Matches fenced code blocks. Anchored to line boundaries so inline triple-backticks are not extracted. */
const CODE_BLOCK_EXTRACT_REGEX = /^[ \t]*```[\s\S]*?^[ \t]*```/gm;
const INLINE_CODE_EXTRACT_REGEX = /`([^`\n]+?)`/g;
// LINK_REGEX is reused for the extract/restore cycle (see extractLinks).
const EMOJI_SHORTCODE_REGEX = /:([A-Za-z0-9_\-+]+?):/g;

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
      chalk.bold((asteriskContent ?? underscoreContent)!),
  );
}

/**
 * Format markdown italic text (* or _)
 */
export function formatItalic(text: string): string {
  let formatted = text;

  formatted = formatted.replace(ITALIC_ASTERISK_REGEX, (_match: string, content: string) =>
    chalk.italic(content),
  );

  formatted = formatted.replace(ITALIC_UNDERSCORE_REGEX, (_match: string, content: string) =>
    chalk.italic(content),
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
 * @param options.availableWidth - Width for wrapping (default: terminal width - 8)
 * @param options.padding - Leading spaces per line (default: 0)
 */
export function formatForTerminal(
  text: string,
  options?: { availableWidth?: number; padding?: number },
): string {
  if (!text || text.length === 0) return text;
  const width = options?.availableWidth ?? getTerminalWidth() - 8;
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
 * Format markdown headings with ANSI colors
 */
export function formatHeadings(text: string): string {
  let formatted = text;

  // H4 (####)
  formatted = formatted.replace(H4_REGEX, (_match, header) => chalk.bold(header));

  // H3 (###)
  formatted = formatted.replace(H3_REGEX, (_match, header) => CHALK_THEME.heading(header));

  // H2 (##)
  formatted = formatted.replace(H2_REGEX, (_match, header) => CHALK_THEME.headingUnderline(header));

  // H1 (#)
  formatted = formatted.replace(H1_REGEX, (_match, header) => CHALK_THEME.headingUnderline(header));

  return formatted;
}

/**
 * Format markdown blockquotes with gray color and visual bar
 */
export function formatBlockquotes(text: string): string {
  return text.replace(BLOCKQUOTE_REGEX, (_match: string, content: string) =>
    chalk.gray(`│ ${content}`),
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
 * Format bare URLs as clickable OSC 8 terminal hyperlinks.
 * @param styleFn - styling function for the displayed text
 */
function formatBareUrlsImpl(text: string, styleFn: (text: string) => string): string {
  return text.replace(BARE_URL_REGEX, (match: string) => {
    const url = match.startsWith("www.") ? `https://${match}` : match;
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

  // 2. Apply inline formatting (escape stripping runs AFTER code extraction)
  formatted = formatEmojiShortcodes(formatted);
  formatted = formatEscapedText(formatted);
  formatted = formatHeadingsHybrid(formatted);
  formatted = formatBlockquotesHybrid(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethroughHybrid(formatted);
  formatted = formatBoldHybrid(formatted);
  formatted = formatItalicHybrid(formatted);

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

  // Apply formatting
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
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
      return `${delimiter}${chalk.bold(content)}${delimiter}`;
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
    (_match: string, content: string) => `*${chalk.italic(content)}*`,
  );

  // Underscore italics - only match if surrounded by whitespace/punctuation
  formatted = formatted.replace(
    HYBRID_ITALIC_UNDERSCORE_REGEX,
    (_match: string, content: string) => `_${chalk.italic(content)}_`,
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
 * Format headings in hybrid mode - keeps # markers visible
 */
export function formatHeadingsHybrid(text: string): string {
  let formatted = text;

  // H4 (####)
  formatted = formatted.replace(H4_REGEX, (_match, header) => `#### ${chalk.bold(header)}`);

  // H3 (###)
  formatted = formatted.replace(H3_REGEX, (_match, header) => `### ${CHALK_THEME.heading(header)}`);

  // H2 (##)
  formatted = formatted.replace(
    H2_REGEX,
    (_match, header) => `## ${CHALK_THEME.headingUnderline(header)}`,
  );

  // H1 (#)
  formatted = formatted.replace(
    H1_REGEX,
    (_match, header) => `# ${CHALK_THEME.headingUnderline(header)}`,
  );

  return formatted;
}

/**
 * Format blockquotes in hybrid mode - keeps > marker visible
 */
export function formatBlockquotesHybrid(text: string): string {
  return text.replace(
    BLOCKQUOTE_REGEX,
    (_match: string, content: string) => `> ${chalk.gray(content)}`,
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

  // Apply hybrid formatting (preserves syntax markers)
  formatted = formatHeadingsHybrid(formatted);
  formatted = formatBlockquotesHybrid(formatted);
  formatted = formatTaskLists(formatted); // Task lists can use standard formatting
  formatted = formatLists(formatted); // Lists can use standard formatting
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethroughHybrid(formatted);
  formatted = formatBoldHybrid(formatted);
  formatted = formatItalicHybrid(formatted);
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
