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

// Pre-compiled regexes for performance - avoid creating RegExp in hot paths
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*m/g;
const BLANK_LINES_REGEX = /\n{3,}/g;
const ESCAPED_TEXT_REGEX = /\\([*_`\\[\]()#+\-.!])/g;
const STRIKETHROUGH_REGEX = /~~([^~\n]+?)~~/g;
const BOLD_REGEX = /(\*\*|__)([^*_\n]+?)\1/g;
const ITALIC_ASTERISK_REGEX = /(?<!\*)\*([^*\n]+?)\*(?!\*)/g;
const ITALIC_UNDERSCORE_REGEX = /(?<!_)_([^_\n]+?)_(?!_)/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;
const H4_REGEX = /^\s*####\s+(.+)$/gm;
const H3_REGEX = /^\s*###\s+(.+)$/gm;
const H2_REGEX = /^\s*##\s+(.+)$/gm;
const H1_REGEX = /^\s*#\s+(.+)$/gm;
const BLOCKQUOTE_REGEX = /^\s*>\s+(.+)$/gm;
const TASK_LIST_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+)$/gm;
const HORIZONTAL_RULE_REGEX = /^\s*([-*_]){3,}\s*$/gm;
// eslint-disable-next-line no-control-regex
const LINK_REGEX = /(?<!\u001b)\[([^\]]+)\]\(([^)]+)\)/g;
/** Matches bare file/folder paths: absolute, ~/home, or word/word. Excludes URLs (no // or ://). */
const FILE_PATH_REGEX =
  /(?<![:\w/])(\/(?!\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]*|~(?:[/a-zA-Z0-9._-]+)+|(?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]*)/g;
/** Matches absolute paths with optional :line or :line:col. Excludes URLs (no // or ://). */
const FILE_PATH_LINE_REGEX =
  /(?<![:\w/])(\/(?!\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+:\d+(?::\d+)?|~(?:[/a-zA-Z0-9._-]+)+:\d+(?::\d+)?)/g;
/** Matches bare URLs: https?:// or www. (common in agent output) */
const BARE_URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+|www\.[^\s<>"{}|\\^`[\]]+)/g;
const CODE_BLOCK_EXTRACT_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_EXTRACT_REGEX = /`([^`\n]+?)`/g;
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
  return text.replace(BOLD_REGEX, (_match: string, _delimiter: string, content: string) =>
    chalk.bold(content),
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
 * Format bare URLs as clickable OSC 8 terminal hyperlinks (rendered mode).
 */
export function formatBareUrls(text: string): string {
  return text.replace(BARE_URL_REGEX, (match: string) => {
    const url = match.startsWith("www.") ? `https://${match}` : match;
    return terminalHyperlink(CHALK_THEME.link(match), url);
  });
}

/**
 * Format bare file/folder paths as links (rendered mode).
 * Only adds OSC 8 hyperlink for absolute or ~/ paths.
 */
export function formatFilePaths(text: string): string {
  let result = text;
  result = result.replace(FILE_PATH_LINE_REGEX, (match: string) => {
    const url = pathWithLineToFileUrl(match);
    const styled = CHALK_THEME.link(match);
    return url ? terminalHyperlink(styled, url) : styled;
  });
  result = result.replace(FILE_PATH_REGEX, (match: string) => {
    const url = pathToFileUrl(match);
    const styled = CHALK_THEME.link(match);
    return url ? terminalHyperlink(styled, url) : styled;
  });
  return result;
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
 * Format code blocks with stateful tracking
 */
export function formatCodeBlocks(text: string, state: StreamingState): FormattingResult {
  let isInCodeBlock = state.isInCodeBlock;

  if (text.includes("```")) {
    const lines = text.split("\n");
    const processedLines: string[] = [];

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        isInCodeBlock = !isInCodeBlock;
        processedLines.push(chalk.yellow(line));
      } else if (isInCodeBlock) {
        processedLines.push(codeColor(line));
      } else {
        processedLines.push(line);
      }
    }

    return {
      formatted: processedLines.join("\n"),
      state: { isInCodeBlock },
    };
  }

  if (isInCodeBlock) {
    return {
      formatted: codeColor(text),
      state: { isInCodeBlock },
    };
  }

  return { formatted: text, state: { isInCodeBlock } };
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
 * Apply progressive formatting for streaming (stateful)
 */
export function applyProgressiveFormatting(text: string, state: StreamingState): FormattingResult {
  if (!text || text.trim().length === 0) {
    return { formatted: text, state };
  }

  // Handle code blocks first (stateful)
  const codeBlockResult = formatCodeBlocks(text, state);
  let formatted = codeBlockResult.formatted;
  const currentState = codeBlockResult.state;

  // If inside a code block, don't apply other formatting
  if (currentState.isInCodeBlock && !text.includes("```")) {
    return { formatted: codeBlockResult.formatted, state: currentState };
  }

  // Apply formatting in order
  formatted = formatEmojiShortcodes(formatted);
  formatted = formatEscapedText(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatInlineCode(formatted);
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatBareUrls(formatted);
  formatted = formatFilePaths(formatted);
  formatted = formatLinks(formatted);

  return { formatted, state: currentState };
}

/**
 * Format complete markdown text (stateless, for non-streaming use)
 */
export function formatMarkdown(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  let formatted = text;
  formatted = stripAnsiCodes(formatted);
  formatted = normalizeBlankLines(formatted);
  formatted = formatEscapedText(formatted);

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

  // Apply formatting
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatBareUrls(formatted);
  formatted = formatFilePaths(formatted);
  formatted = formatLinks(formatted);

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
const HYBRID_ITALIC_UNDERSCORE_REGEX = /(?<=^|[\s[(])_([^_\n]+?)_(?=[\s\],.!?)]|$)/g;

/**
 * Format bold text in hybrid mode - keeps ** markers visible
 */
export function formatBoldHybrid(text: string): string {
  return text.replace(
    BOLD_REGEX,
    (_match: string, delimiter: string, content: string) =>
      `${delimiter}${chalk.bold(content)}${delimiter}`,
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
  const pathPart = match.slice(0, match.indexOf(":" + lineColMatch[1]!));
  const line = lineColMatch[1]!;
  const col = lineColMatch[2];
  const url = pathToFileUrl(pathPart);
  if (!url) return null;
  return col ? `${url}:${line}:${col}` : `${url}:${line}`;
}

function styleAsLink(text: string): string {
  return chalk.italic(CHALK_THEME.link(text));
}

/**
 * Format bare file/folder paths in hybrid mode — styled as links.
 * Only adds OSC 8 hyperlink for absolute or ~/ paths (relative are impossible to click).
 */
function formatFilePathsHybrid(text: string): string {
  let result = text;
  // File:line first (absolute only) — more specific
  result = result.replace(FILE_PATH_LINE_REGEX, (match: string) => {
    const url = pathWithLineToFileUrl(match);
    const styled = styleAsLink(match);
    return url ? terminalHyperlink(styled, url) : styled;
  });
  // Plain paths
  result = result.replace(FILE_PATH_REGEX, (match: string) => {
    const url = pathToFileUrl(match);
    const styled = styleAsLink(match);
    return url ? terminalHyperlink(styled, url) : styled;
  });
  return result;
}

/**
 * Format bare URLs in hybrid mode — styled as links and wrapped in OSC 8 hyperlinks.
 */
function formatBareUrlsHybrid(text: string): string {
  return text.replace(BARE_URL_REGEX, (match: string) => {
    const url = match.startsWith("www.") ? `https://${match}` : match;
    return terminalHyperlink(styleAsLink(match), url);
  });
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

  // Apply hybrid formatting (preserves syntax markers)
  formatted = formatHeadingsHybrid(formatted);
  formatted = formatBlockquotesHybrid(formatted);
  formatted = formatTaskLists(formatted); // Task lists can use standard formatting
  formatted = formatLists(formatted); // Lists can use standard formatting
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethroughHybrid(formatted);
  formatted = formatBoldHybrid(formatted);
  formatted = formatItalicHybrid(formatted);
  formatted = formatBareUrlsHybrid(formatted);
  formatted = formatFilePathsHybrid(formatted);
  formatted = formatLinksHybrid(formatted);

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
